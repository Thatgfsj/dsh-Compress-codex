#!/usr/bin/env bash
# Map sync-preset-codex exit codes onto a CI verdict (#23).
#
#   exit 0  -> PASS: the anchor (or the selftest) was actually verified
#   exit 2  -> INCOMPLETE: no dsh install / preset file reachable. This is the
#             allowed SKIP: the job stays green, but it never says PASS, and it
#             emits a warning annotation so the unverified state is visible.
#   other   -> FAIL: the upstream preset changed, the anchor is stale, or the
#             generator can no longer retarget the patch.
#
# Usage: bash scripts/preset-drift-check.sh [--selftest]
set -u

MODE="anchor"
ARGS=("--check")
if [ "${1:-}" = "--selftest" ]; then
  MODE="selftest"
  ARGS=("--selftest")
fi

set +e
OUTPUT="$(node scripts/sync-preset-codex.mjs "${ARGS[@]}" 2>&1)"
CODE=$?
set -e
printf '%s\n' "$OUTPUT"

case "$CODE" in
  0)
    echo "PRESET-DRIFT: PASS ($MODE verified)"
    ;;
  2)
    echo "::warning::PRESET-DRIFT: INCOMPLETE - SKIPPED ($MODE NOT verified: no dsh install or preset file reachable)"
    echo "PRESET-DRIFT: INCOMPLETE - SKIPPED ($MODE NOT verified)"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      printf 'PRESET-DRIFT: INCOMPLETE - %s NOT verified\n' "$MODE" >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;
  *)
    echo "::error::PRESET-DRIFT: FAIL ($MODE) - see the log above"
    exit 1
    ;;
esac
