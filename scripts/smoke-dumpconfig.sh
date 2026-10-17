#!/usr/bin/env bash
#
# M1-2 (#2) seam smoke test.
#
# Proves, against a throwaway DSH_HOME and throwaway profiles, that this bundle
# really swaps the compaction backend:
#
#   1. the official `compaction-basic` row is disabled *by our layer*
#   2. our `compaction-codex` row is inserted and resolves to this package
#   3. the loader reported no unresolved patch target ("patch: entry ... not found")
#
# plus a negative control: in a profile that does NOT include this bundle the same
# row is present and enabled, so assertion 1 measures our patch and not the
# template. (The `web` template is unsuitable for that reason: it disables
# compaction-basic on its own, and the dump attributes that row to dsh-web-app.)
#
# It is deliberately NOT part of the CI gate: it needs a real `dsh` install and
# pnpm, while the gate runs with zero node_modules so that a registry outage can
# never block main. When those tools are missing the script prints
# SMOKE RESULT: SKIPPED and exits 0 — a skip is not a pass, and must be reported
# as "not verified" in the PR.
#
# Usage: bash scripts/smoke-dumpconfig.sh
# Env:   SMOKE_PROFILE (default: codexsmoke), DSH_BIN (default: dsh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(dirname "${BASH_SOURCE[0]}")")" && pwd)"
PROFILE="${SMOKE_PROFILE:-codexsmoke}"
CONTROL_PROFILE="${PROFILE}-control"
DSH="${DSH_BIN:-dsh}"

skip() {
  printf 'SMOKE RESULT: SKIPPED (%s)\n' "$1"
  printf 'SMOKE NOTE: this run verified nothing; report it as unverified.\n'
  exit 0
}

command -v "$DSH" >/dev/null 2>&1 || skip "$DSH is not on PATH"
command -v pnpm >/dev/null 2>&1 || skip "pnpm is not on PATH, and 'dsh plugin add' needs it"

# The path must not exist yet: the guard resolveLoose()s it, and on macOS an
# existing /var/folders path realpaths away from os.tmpdir() and false-fails.
export DSH_HOME="${TMPDIR:-/tmp}/dsh-compress-codex-smoke.$$"
node "$REPO_ROOT/scripts/assert-isolated-home.mjs" >/dev/null
mkdir -p "$DSH_HOME"
trap 'rm -rf "$DSH_HOME" "$DUMP" "$ERR" "$CONTROL"' EXIT

DUMP="$(mktemp)"
ERR="$(mktemp)"
CONTROL="$(mktemp)"

# 'dsh plugin add' also creates a missing profile. The result is the minimal
# dsh-base + this-bundle stack, with no other layer touching the compaction rows.
"$DSH" plugin --profile "$PROFILE" add "$REPO_ROOT" >/dev/null
"$DSH" --profile "$PROFILE" --dump-config >"$DUMP" 2>"$ERR"

# Negative control: a stock template that does not contain this bundle.
"$DSH" --profile "$CONTROL_PROFILE" --from-default-profile headless --dump-config >"$CONTROL" 2>/dev/null

# Print the annotation line above an entry id plus the entry's own block.
block() {
  awk -v id="$2" '
    /^# == /          { annotation = $0; next }
    /^- id: /         { inside = ($0 == "- id: " id); if (inside) { print annotation; print $0 } ; next }
    inside && /^  /   { print; next }
    inside            { inside = 0 }
  ' "$1"
}

fail() {
  printf 'SMOKE RESULT: FAIL — %s\n' "$1"
  printf '\n--- compaction rows ---\n'
  block "$DUMP" compaction-basic
  block "$DUMP" compaction-codex
  printf '\n--- loader stderr ---\n'
  cat "$ERR"
  exit 1
}

grep -q 'patch: entry' "$ERR" && fail "loader could not resolve a patch target"
grep -qi 'not found' "$ERR" && fail "loader reported a missing entry"

basic="$(block "$DUMP" compaction-basic)"
case "$basic" in
  *'patched by dsh-compress-codex'*) ;;
  *) fail "compaction-basic is not attributed to this bundle:"$'\n'"$basic" ;;
esac
case "$basic" in
  *'disabled: true'*) ;;
  *) fail "compaction-basic is not disabled after our layer:"$'\n'"$basic" ;;
esac

codex="$(block "$DUMP" compaction-codex)"
case "$codex" in
  *'# == dsh-compress-codex'*) ;;
  *) fail "compaction-codex is not mounted:"$'\n'"$codex" ;;
esac
case "$codex" in
  *'name: dsh-compress-codex'*) ;;
  *) fail "compaction-codex does not resolve to this package:"$'\n'"$codex" ;;
esac

control="$(block "$CONTROL" compaction-basic)"
case "$control" in
  '') fail "negative control found no compaction-basic row; the assertion would be vacuous" ;;
  *'disabled: true'*) fail "negative control: compaction-basic is already disabled without this bundle" ;;
  *) printf 'SMOKE OK  : negative control — compaction-basic is live without this bundle\n' ;;
esac

printf 'SMOKE OK  : compaction-basic disabled by this bundle\n'
printf 'SMOKE OK  : compaction-codex mounted from this package\n'
printf 'SMOKE OK  : no unresolved patch target\n'
printf 'SMOKE RESULT: PASS\n'
