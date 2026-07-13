#!/usr/bin/env bash
#
# loop.sh — drive Kodr over a checklist backlog until each task is done or capped.
#
# Kodr is a one-shot harness: one `kodr run` is one task. This script is the
# *outer loop* the harness deliberately doesn't build in (zero-dep, do-one-thing):
# it reads the next unchecked item from TASKS.md, runs Kodr against it, and uses
# the machine-readable `--json` summary to decide done / retry / park.
#
# The ratchet that keeps iteration monotonic instead of a random walk:
#   - only a run that COMPLETED, actually touched the workspace, and did not fail
#     verification gets committed (a green commit is the unit of progress);
#   - a red attempt retries in place with `--continue last` (the broken code stays
#     on disk for the model to fix, and the prior transcript is replayed);
#   - giving up reverts the attempt (`git reset --hard`) so the tree stays green,
#     and marks the task blocked so it isn't picked again.
#
# Requirements: kodr on PATH, `jq`, and a git repo. `jq` is this script's
# dependency, not Kodr's. For an overnight run, launch it detached
# (`nohup ./examples/loop.sh >loop.out 2>&1 & disown`) rather than in a
# foreground shell that may be culled.
#
# Config via env:
#   MAX_ATTEMPTS   cross-run retries per task before parking (default 3)
#   TEST_CMD       verification command; empty string disables --test (default "npm test")
#   TASKS_FILE     the checklist (default TASKS.md)
#   TOOL_TURNS     per-run tool-turn ceiling (default 30)
#   RUN_MS         per-run wall-clock budget in ms, 0 disables (default 900000 = 15m)
set -uo pipefail

MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
TEST_CMD=${TEST_CMD:-npm test}
TASKS_FILE=${TASKS_FILE:-TASKS.md}
TOOL_TURNS=${TOOL_TURNS:-30}
RUN_MS=${RUN_MS:-900000}

command -v kodr >/dev/null || { echo "kodr not on PATH" >&2; exit 1; }
command -v jq   >/dev/null || { echo "jq not on PATH (needed by this loop)" >&2; exit 1; }
[ -f "$TASKS_FILE" ] || { echo "no $TASKS_FILE" >&2; exit 1; }

# First unchecked "- [ ] ..." line, sans the marker. Empty when the backlog is done.
next_task() { grep -m1 '^- \[ \] ' "$TASKS_FILE" 2>/dev/null | sed 's/^- \[ \] //'; }

# Flip the FIRST unchecked line's marker to $1 (x = done, ! = blocked). Portable
# awk rewrite — next_task always hands us the first unchecked line, so "first" is
# unambiguous within one iteration.
mark_first() {
  awk -v m="$1" '
    !done && /^- \[ \] / { sub(/^- \[ \] /, "- [" m "] "); done=1 }
    { print }
  ' "$TASKS_FILE" > "$TASKS_FILE.tmp" && mv "$TASKS_FILE.tmp" "$TASKS_FILE"
}

test_args=()
[ -n "$TEST_CMD" ] && test_args=(--test "$TEST_CMD")

while task="$(next_task)"; [ -n "$task" ]; do
  echo "=== $task"
  attempt=0; cont=(); green=false
  while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    out="$(kodr run "$task" "${test_args[@]}" \
             --memory --memory-auto-apply \
             --max-tool-turns "$TOOL_TURNS" --max-run-ms "$RUN_MS" \
             --json --no-fail "${cont[@]}")"
    # Done = completed AND actually changed something (not a no-op completion)
    # AND verification did not fail. noOpCompletion guards a "complete" run that
    # quietly did nothing — otherwise indistinguishable from real success.
    green="$(printf '%s' "$out" | jq -r '.completed and (.noOpCompletion | not) and (.verified != false)')"
    [ "$green" = "true" ] && break
    echo "  attempt $attempt not green → --continue"
    cont=(--continue last)   # retry in place; keep the broken state for the model
  done

  if [ "$green" = "true" ]; then
    git add -A && git commit -q -m "kodr: $task"
    mark_first x
    echo "  committed."
  else
    echo "  PARKED after $MAX_ATTEMPTS attempts" | tee -a loop.log
    git reset --hard -q      # discard the failed attempt; keep the tree green
    mark_first '!'
  fi
done

echo "backlog empty."
kodr stats
