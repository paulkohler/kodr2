#!/usr/bin/env bash
#
# phased-loop.sh — drive Kodr over a checklist that mixes hard-gated tasks
# and fuzzy, judged goals, one phase at a time.
#
# loop.sh's checklist only knows one shape: a task, gated by a test command.
# That's the right tool for "add input validation" or "write a test for the
# empty-input case" — a shell command can check those. It's the wrong tool
# for "every endpoint has an owner check retrofitted" or "the README
# documents every endpoint" — no test command can grep for "did the model
# actually audit everything," only a grounded model judge can (see
# specs/goal.yaml). A realistic multi-phase build (see examples/crm-phases.md)
# has both kinds of item in the same plan.
#
# This script is loop.sh's ratchet (commit on green, retry in place on red,
# revert-and-park on giving up), with one branch added: a checklist line
# prefixed "GOAL: " is driven by `kodr goal` — its own build+test+judge
# attempt loop, capped at GOAL_MAX_ATTEMPTS — instead of a bare `kodr run`
# capped at MAX_ATTEMPTS, this script's own outer retry loop with --continue.
#
# Requirements: same as loop.sh — kodr on PATH, `jq`, and a git repo. For an
# overnight run, launch it detached (`nohup ./examples/phased-loop.sh
# >phased-loop.out 2>&1 & disown`) rather than in a foreground shell that may
# be culled — a 15-phase checklist with a couple of GOAL: items easily runs
# for hours.
#
# Config via env:
#   MAX_ATTEMPTS       outer retries per plain task before parking (default 3)
#   GOAL_MAX_ATTEMPTS  kodr goal's own internal build+judge attempts per
#                      GOAL: item before parking (default 4 — one more than a
#                      plain task gets, since a judged condition often needs
#                      an extra round to nail something like doc completeness)
#   TEST_CMD           verification command; empty string disables --test (default "npm test")
#   TASKS_FILE         the checklist (default TASKS.md)
#   TOOL_TURNS         per-attempt tool-turn ceiling (default 30)
#   RUN_MS             per-attempt wall-clock budget in ms, 0 disables (default 900000 = 15m)
set -uo pipefail

MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
GOAL_MAX_ATTEMPTS=${GOAL_MAX_ATTEMPTS:-4}
TEST_CMD=${TEST_CMD:-npm test}
TASKS_FILE=${TASKS_FILE:-TASKS.md}
TOOL_TURNS=${TOOL_TURNS:-30}
RUN_MS=${RUN_MS:-900000}

command -v kodr >/dev/null || { echo "kodr not on PATH" >&2; exit 1; }
command -v jq   >/dev/null || { echo "jq not on PATH (needed by this loop)" >&2; exit 1; }
[ -f "$TASKS_FILE" ] || { echo "no $TASKS_FILE" >&2; exit 1; }

# First unchecked "- [ ] ..." line, sans the marker. Empty when the backlog is
# done. A GOAL: prefix (if present) rides along in the returned text — the
# branch below strips it, next_task doesn't need to know about it.
next_task() { grep -m1 '^- \[ \] ' "$TASKS_FILE" 2>/dev/null | sed 's/^- \[ \] //'; }

# Flip the FIRST unchecked line's marker to $1 (x = done, ! = blocked). Portable
# awk rewrite — next_task always hands us the first unchecked line, so "first"
# is unambiguous within one iteration.
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
  green=false
  park_note="PARKED after $MAX_ATTEMPTS attempts"

  if [[ "$task" == "GOAL: "* ]]; then
    condition="${task#"GOAL: "}"
    out="$(kodr goal "$condition" "${test_args[@]}" \
             --max-attempts "$GOAL_MAX_ATTEMPTS" \
             --max-tool-turns "$TOOL_TURNS" --max-run-ms "$RUN_MS" \
             --json --no-fail)"
    # Done = a grounded judge said MET, on an attempt that actually changed
    # something, on a build that didn't fail verification. kodr goal already
    # retried internally (build + judge, up to GOAL_MAX_ATTEMPTS) with its own
    # continuation — there is no outer retry loop for a GOAL: item, since
    # re-running it fresh would just repeat the same attempts with no memory
    # of what the judge already said.
    green="$(printf '%s' "$out" | jq -r '.met and ((.filesChanged | length) > 0) and (.verified != false)')"
    reason="$(printf '%s' "$out" | jq -r '.reason')"
    attempts="$(printf '%s' "$out" | jq -r '.attempts')"
    park_note="PARKED after $attempts goal attempt(s): $reason"
  else
    attempt=0; cont=()
    while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
      attempt=$((attempt + 1))
      out="$(kodr run "$task" "${test_args[@]}" \
               --memory --memory-auto-apply \
               --max-tool-turns "$TOOL_TURNS" --max-run-ms "$RUN_MS" \
               --json --no-fail "${cont[@]}")"
      # Done = completed AND actually changed something (not a no-op
      # completion) AND verification did not fail. noOpCompletion guards a
      # "complete" run that quietly did nothing — otherwise indistinguishable
      # from real success.
      green="$(printf '%s' "$out" | jq -r '.completed and (.noOpCompletion | not) and (.verified != false)')"
      [ "$green" = "true" ] && break
      echo "  attempt $attempt not green → --continue"
      cont=(--continue last)   # retry in place; keep the broken state for the model
    done
  fi

  if [ "$green" = "true" ]; then
    # Mark first, commit second — the checklist tick rides in the same commit
    # as the code, so it survives any later task's `git reset --hard`. (A
    # commit-then-mark order leaves the tick uncommitted, and a later park's
    # reset silently reverts this task back to unchecked — it gets redone.)
    mark_first x
    git add -A && git commit -q -m "kodr: $task"
    echo "  committed."
  else
    echo "  $park_note" | tee -a phased-loop.log
    git reset --hard -q      # discard the failed attempt(s); keep the tree green
    mark_first '!'
    # Commit the park mark on its own — same reason as above, but the mark
    # has to happen after the reset here, so it needs its own tiny commit
    # instead of riding along with one that already happened.
    git add "$TASKS_FILE" && git commit -q -m "kodr: park $task"
  fi
done

echo "backlog empty."
kodr stats
