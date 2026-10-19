#!/usr/bin/env bash
# Map sync-preset-codex exit codes onto a CI verdict (#23), plus the offline
# codex-ptc criteria (#62, docs/ci-codex-ptc.md).
#
#   exit 0  -> PASS: the anchor (or the selftest) was actually verified
#   exit 2  -> INCOMPLETE: no dsh install / preset file reachable. This is the
#             allowed SKIP: the job stays green, but it never says PASS, and it
#             emits a warning annotation so the unverified state is visible.
#   other   -> FAIL: the upstream preset changed, the anchor is stale, or the
#             generator can no longer retarget the patch.
#
# Usage: bash scripts/preset-drift-check.sh [--selftest | --offline]
#
# --offline runs the O-series criteria (docs/ci-codex-ptc.md section 1.1/2/5).
# It is deliberately NOT a separate CI job: it reuses the same dsh install as
# the anchor check, because a second job would pay the ~36s install again.
set -u

MODE="anchor"
ARGS=("--check")
if [ "${1:-}" = "--selftest" ]; then
  MODE="selftest"
  ARGS=("--selftest")
elif [ "${1:-}" = "--offline" ]; then
  MODE="offline"
fi

# -- verdict ------------------------------------------------------------------
#
# Emit one verdict line and assert the INVARIANT that makes it honest: an
# INCOMPLETE verdict must never contain the substring PASS. The assertion is
# mechanical on purpose (docs/ci-codex-ptc.md section 5.1) -- a skip is not a
# pass, so the script tests that property instead of trusting eyes.
verdict() {
  local state="$1"; shift
  local text="$*"
  if [ "$state" = "INCOMPLETE" ]; then
    case "$text" in
      *PASS*)
        echo "::error::PRESET-DRIFT: self-check failed - an INCOMPLETE verdict contained PASS"
        echo "PRESET-DRIFT: FAIL (verdict self-check)"
        exit 1
        ;;
    esac
    echo "::warning::PRESET-DRIFT: $state - $text"
  elif [ "$state" = "FAIL" ]; then
    echo "::error::PRESET-DRIFT: $state - $text"
  fi
  echo "PRESET-DRIFT: $state - $text"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf 'PRESET-DRIFT: %s - %s\n' "$state" "$text" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# -- anchor / selftest modes (unchanged behaviour, #23) -----------------------
if [ "$MODE" != "offline" ]; then
  set +e
  OUTPUT="$(node scripts/sync-preset-codex.mjs "${ARGS[@]}" 2>&1)"
  CODE=$?
  set -e
  printf '%s\n' "$OUTPUT"
  case "$CODE" in
    0) verdict PASS "$MODE verified" ;;
    2) verdict INCOMPLETE "$MODE NOT verified: no dsh install or preset file reachable" ;;
    *) verdict FAIL "$MODE - see the log above"; exit 1 ;;
  esac
  exit 0
fi

# -- offline criteria ---------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Bases we try. A base with no recorded anchor is INCOMPLETE, not FAIL: nothing
# was verified for it, and not-baselined-yet is not the-upstream-changed. So
# landing the ptc anchor needs no edit here.
BASES="standard ptc"

# The checker judges ONE generated file against ONE source file. It is a separate
# program because fault injection below calls it again on corrupted copies: the
# SAME code path must decide the real run and the mutations, or the reverse proof
# would prove nothing about the real run.
CHECKER="$WORK/check-preset.mjs"
cat > "$CHECKER" <<'CHECKER_EOF'
import { readFileSync } from 'node:fs'

const [, , sourcePath, generatedPath, label] = process.argv
const source = readFileSync(sourcePath, 'utf8')
const generated = readFileSync(generatedPath, 'utf8')
const failures = []
const fail = (message) => failures.push(message)

// O1/O2/O3. Each carries the SOURCE-side pre-condition that makes it
// non-vacuous (docs/ci-codex-ptc.md section 5.2): asserting the generated file
// has X without first asserting the source had X degrades into checking nothing
// once upstream drops X, which is a silent pass.
const REQUIRED = [
  {
    id: 'O1 tool-presentation is in ptc mode',
    sourcePattern: /mode:\s*ptc/,
    generatedPattern: /mode:\s*ptc/,
    vacuous: 'the upstream preset no longer declares mode: ptc'
  },
  {
    id: 'O2 workflow-ptc and tool-workflow stay disabled',
    sourcePattern: /- id:\s*(workflow-ptc|tool-workflow)/,
    generatedPattern: /- id:\s*(workflow-ptc|tool-workflow)\s*\n\s*name:[^\n]*\n\s*disabled:\s*true/,
    vacuous: 'the upstream preset no longer carries the disabled workflow rows'
  },
  {
    id: 'O3 the isolated compaction group is retargeted',
    sourcePattern: /- id:\s*compaction-basic/,
    generatedPattern: /- id:\s*compaction-codex/,
    vacuous: 'the upstream preset no longer carries the compaction-basic row'
  }
]

// O1/O2 describe the ptc base specifically; the standard base has neither a
// mode: ptc row nor the disabled workflow rows, so requiring them there would
// fail for the wrong reason. Applicability is decided by the SOURCE, and a
// source that should have carried them but does not is reported as vacuous.
const PTC_ONLY = new Set(['O1 tool-presentation is in ptc mode', 'O2 workflow-ptc and tool-workflow stay disabled'])
const isPtc = /- id: preset-ptc/.test(source)

for (const rule of REQUIRED) {
  if (PTC_ONLY.has(rule.id) && !isPtc) continue
  if (!rule.sourcePattern.test(source)) {
    fail(rule.id + ': VACUOUS - ' + rule.vacuous + ' (nothing to verify, so this is not a pass)')
    continue
  }
  if (!rule.generatedPattern.test(generated)) fail(rule.id + ': the generated preset does not satisfy it')
}

// O3b: the retarget must be complete. No official backend may survive, and the
// two backend-independent rows must remain (docs/PLAN.md section 2.1).
if (/- id:\s*compaction-basic/.test(generated)) fail('O3b: compaction-basic survived the retarget')
if (!/name:\s*'dsh-compress-codex'/.test(generated)) fail('O3b: the plugin row name is missing')
if (!/- id:\s*command-compact/.test(source)) {
  fail('O3b: VACUOUS - the upstream preset no longer carries command-compact')
} else if (!/- id:\s*command-compact/.test(generated)) {
  fail('O3b: command-compact was dropped, but /compact must keep working')
}

// O4: every line that differs between source and generated must be an expected
// rewrite, and the expected set is COMPUTED from the rewrite rules rather than a
// hardcoded line count -- a fixed count would let an upstream roster addition
// slip through (docs/ci-codex-ptc.md section 5.4).
const sourceLines = source.split(/\r?\n/)
const generatedLines = generated.split(/\r?\n/)
const insertAt = (rows) => rows.findIndex((line) => line.trim() === '- insert:')
const sourceStart = insertAt(sourceLines)
const generatedStart = insertAt(generatedLines)
if (sourceStart === -1) fail('O4: the upstream source has no top-level insert row')
if (generatedStart === -1) fail('O4: the generated preset has no top-level insert row')

const trimTail = (rows) => {
  let end = rows.length
  while (end > 0 && rows[end - 1].trim() === '') end -= 1
  return rows.slice(0, end)
}
const sourceBody = sourceStart === -1 ? [] : trimTail(sourceLines.slice(sourceStart))
const generatedBody = generatedStart === -1 ? [] : trimTail(generatedLines.slice(generatedStart))
if (sourceBody.length !== generatedBody.length) {
  fail('O4: the retarget changed the row count (' + sourceBody.length + ' -> ' + generatedBody.length + ')')
}

// The rewrites the generator is allowed to perform, as source/generated pattern
// pairs. Anything else differing is an unreviewed change.
const REWRITES = [
  [/^\s*- id: preset-[a-z0-9-]+$/, /^\s*- id: preset-codex(-ptc)?$/],
  [/^\s*id: [a-z0-9-]+$/, /^\s*id: (codex|codex-ptc)$/],
  [/^\s*order:\s*\d+$/, /^\s*order:\s*\d+$/],
  [/^\s*- id: compaction-basic$/, /^\s*- id: compaction-codex$/],
  [/^\s*name: '@deepseek-ai\/dsh-compaction-basic'$/, /^\s*name: 'dsh-compress-codex'$/]
]
let differing = 0
for (let index = 0; index < Math.min(sourceBody.length, generatedBody.length); index += 1) {
  const before = sourceBody[index]
  const after = generatedBody[index]
  if (before === after) continue
  differing += 1
  if (!REWRITES.some(([from, to]) => from.test(before) && to.test(after))) {
    fail('O4: unexpected difference at body line ' + (index + 1) + ': ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after))
  }
}
if (differing === 0) fail('O4: source and generated are identical, so nothing was retargeted')

// Evidence ledger, so a green run is reviewable (docs/ci-codex-ptc.md 5.5).
const evidence = {
  label,
  sourcePath,
  generatedPath,
  sourceBytes: source.length,
  generatedBytes: generated.length,
  rewrittenLines: differing,
  checks: REQUIRED.length + 3
}
if (failures.length > 0) {
  console.log(JSON.stringify({ ...evidence, ok: false, failures }, null, 1))
  process.exit(1)
}
console.log(JSON.stringify({ ...evidence, ok: true }))
CHECKER_EOF

run_check() {
  node "$CHECKER" "$1" "$2" "$3"
}

VERDICTS=""
record() { VERDICTS="$VERDICTS$1"$'\n'; }

for BASE in $BASES; do
  GEN="$WORK/$BASE.yml"
  SRC="$WORK/$BASE.source"
  ANCHORS="$WORK/$BASE-anchors.json"
  cp scripts/preset-anchors.json "$ANCHORS"

  set +e
  OUTPUT="$(node scripts/sync-preset-codex.mjs --base "$BASE" --anchors "$ANCHORS" --out "$GEN" 2>&1)"
  CODE=$?
  set -e

  # The generator prints the resolved source path; record it for the checker and
  # for fault injection, which needs a pristine source to re-judge against.
  SOURCE="$(printf '%s\n' "$OUTPUT" | awk '/^sync-preset-codex: source /{print $3; exit}')"

  if [ "$CODE" = "2" ]; then
    verdict INCOMPLETE "$BASE: no dsh install or preset source reachable"
    record INCOMPLETE
    continue
  fi
  if [ "$CODE" != "0" ]; then
    case "$OUTPUT" in
      *"no anchor recorded"*)
        verdict INCOMPLETE "$BASE: no anchor recorded yet, so its preset was not verified"
        record INCOMPLETE
        continue
        ;;
    esac
    printf '%s\n' "$OUTPUT"
    verdict FAIL "$BASE: generator failed - see the log above"
    record FAIL
    continue
  fi
  if [ ! -f "$GEN" ] || [ -z "$SOURCE" ] || [ ! -f "$SOURCE" ]; then
    verdict FAIL "$BASE: the generator reported success but wrote no usable artifact"
    record FAIL
    continue
  fi

  cp "$SOURCE" "$SRC"
  set +e
  RESULT="$(run_check "$SRC" "$GEN" "$BASE" 2>&1)"
  CHECK=$?
  set -e
  printf '%s\n' "$RESULT"
  if [ "$CHECK" = "0" ]; then
    verdict PASS "$BASE: offline criteria hold (O1-O4)"
    record PASS
  else
    verdict FAIL "$BASE: offline criteria violated (see the JSON above)"
    record FAIL
  fi
done

# -- fault injection: every mutation must turn the checker red -----------------
#
# docs/ci-codex-ptc.md section 5.3. This is what keeps the PASS above from being
# an artifact of a checker that never fails.
# Fault injection runs against EVERY generated artifact, so a mutation that only
# applies to one base (e.g. mode: ptc) is still exercised on the base that has it.
# A base with no artifact is skipped loudly; a mutation that cannot apply to an
# artifact that DOES exist is a real gap and counts as a miss.
FAULTS=0
MISSED=0
INJECTED=0
mutate() {
  local file="$1" source_file="$2" label="$3" from="$4" to="$5"
  local copy="$WORK/mutated.yml"
  FAULTS=$((FAULTS + 1))
  sed "s|$from|$to|" "$file" > "$copy"
  if cmp -s "$file" "$copy"; then
    echo "::error::fault injection could not apply: $label - the mutation did not change the artifact"
    MISSED=$((MISSED + 1))
    return
  fi
  INJECTED=$((INJECTED + 1))
  set +e
  run_check "$source_file" "$copy" "$label" >/dev/null 2>&1
  local status=$?
  set -e
  if [ "$status" = "0" ]; then
    echo "::error::fault injection SURVIVED: $label - the checker accepted a corrupted preset"
    MISSED=$((MISSED + 1))
  else
    echo "PRESET-DRIFT: fault caught - $label"
  fi
}

for BASE in $BASES; do
  if [ ! -f "$WORK/$BASE.yml" ] || [ ! -f "$WORK/$BASE.source" ]; then
    echo "PRESET-DRIFT: fault injection SKIPPED for $BASE - no generated preset to corrupt"
    continue
  fi
  ARTIFACT="$WORK/$BASE.yml"
  ARTIFACT_SOURCE="$WORK/$BASE.source"
  mutate "$ARTIFACT" "$ARTIFACT_SOURCE" "$BASE: compaction-codex -> compaction-basic" "id: compaction-codex" "id: compaction-basic"
  mutate "$ARTIFACT" "$ARTIFACT_SOURCE" "$BASE: plugin row renamed back to the official backend" "name: 'dsh-compress-codex'" "name: '@deepseek-ai/dsh-compaction-basic'"
  mutate "$ARTIFACT" "$ARTIFACT_SOURCE" "$BASE: preset row id rewritten" "- id: preset-codex" "- id: preset-baseline"
  if grep -q "mode: ptc" "$ARTIFACT"; then
    mutate "$ARTIFACT" "$ARTIFACT_SOURCE" "$BASE: mode ptc -> native" "mode: ptc" "mode: native"
  fi
done

if [ "$FAULTS" = "0" ]; then
  verdict INCOMPLETE "fault injection skipped: no generated preset was available to corrupt"
  record INCOMPLETE
elif [ "$MISSED" != "0" ]; then
  verdict FAIL "fault injection: $MISSED of $FAULTS mutations did not turn the checker red"
  record FAIL
else
  verdict PASS "fault injection: $FAULTS of $FAULTS mutations turned the checker red ($INJECTED applied)"
  record PASS
fi

# -- aggregate ----------------------------------------------------------------
# FAIL outranks INCOMPLETE outranks PASS. INCOMPLETE keeps the job green (the
# dependency was unreachable) but never claims a pass.
if printf '%s' "$VERDICTS" | grep -qx FAIL; then
  exit 1
fi
if printf '%s' "$VERDICTS" | grep -qx INCOMPLETE; then
  verdict INCOMPLETE "one or more bases were not verified (see the per-base verdicts above)"
  exit 0
fi
verdict PASS "all offline criteria verified"
exit 0
