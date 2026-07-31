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
# Requirements: kodr on PATH, `jq`, a git repo, and bash >= 4.4 (an empty
# array expansion like "${cont[@]}" under `set -u` is an unbound-variable
# error on older bash, e.g. macOS's preinstalled /bin/bash 3.2 -- make sure
# `env bash` resolves to something newer, such as Homebrew's). For an
# overnight run, launch it detached (`nohup ./examples/loop.sh >loop.out
# 2>&1 & disown`) rather than in a foreground shell that may be culled.
#
# Config via env:
#   MAX_ATTEMPTS       cross-run retries per task before parking (default 3)
#   TEST_CMD           verification command; empty string disables --test (default "npm test")
#   TASKS_FILE         the checklist (default TASKS.md)
#   TOOL_TURNS         per-run tool-turn ceiling (default 30)
#   RUN_MS             per-run wall-clock budget in ms, 0 disables (default 900000 = 15m)
#   REQUEST_TIMEOUT_MS per-HTTP-request ceiling passed to kodr's --request-timeout-ms;
#                      unset leaves kodr's own default (600000 = 10m). A large local
#                      model under load can outrun 10 minutes on a single request well
#                      before RUN_MS's own budget is used up — raise this alongside
#                      RUN_MS for a big overnight run rather than leaving it implicit.
#   RETRY_BACKOFF_S    seconds to sleep before retrying an attempt that ended with
#                      stoppedReason "error" (a transient backend failure -- an LM
#                      Studio HTTP 500 or a request timeout -- not a genuine build/test
#                      failure). Default 5. Retrying an infra hiccup instantly tends to
#                      hit the same hiccup again; a real build/test failure gets no
#                      delay, since the model still has to act, not wait.
#   RESET_PATHS        space-separated gitignored paths (e.g. "data") to `rm -rf` on
#                      park, alongside `git reset --hard`. Empty/unset by default --
#                      `git reset --hard` only reverts *tracked* files, so a database
#                      or cache dir an abandoned attempt migrated/mutated survives the
#                      park untouched, silently carrying that attempt's damage forward
#                      into every later task. Opt in per project once you know which
#                      paths are safe to blow away and recreated on demand.
#   STOP_ON_PARK       stop the whole loop when a task parks, instead of carrying on to
#                      the next one (default 0 -- a backlog is often independent tasks,
#                      where one failure need not block the rest). Set to 1 when the
#                      list is ordered and each item builds on the last; phased-loop.sh
#                      defaults it the other way for exactly that reason.
set -uo pipefail

MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
TEST_CMD=${TEST_CMD:-npm test}
TASKS_FILE=${TASKS_FILE:-TASKS.md}
TOOL_TURNS=${TOOL_TURNS:-30}
RUN_MS=${RUN_MS:-900000}
RETRY_BACKOFF_S=${RETRY_BACKOFF_S:-5}
RESET_PATHS=${RESET_PATHS:-}
STOP_ON_PARK=${STOP_ON_PARK:-0}

command -v kodr >/dev/null || { echo "kodr not on PATH" >&2; exit 1; }
command -v jq   >/dev/null || { echo "jq not on PATH (needed by this loop)" >&2; exit 1; }
[ -f "$TASKS_FILE" ] || { echo "no $TASKS_FILE" >&2; exit 1; }
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || { echo "not a git repo" >&2; exit 1; }

# ...and a repo with at least one commit. `git reset --hard` is a silent no-op
# when there is no HEAD, so a park falls straight through to `git clean -fd`
# with nothing tracked -- which deletes every untracked file in the tree, the
# checklist included. The run then dies on the next mark with the plan gone.
# Refuse at startup instead: it is the operator's very first action, and a
# one-line fix, but a confusing three-error cascade an hour into an unattended
# run if it fires there.
git rev-parse --verify HEAD >/dev/null 2>&1 || {
  echo "no commits in this repo yet -- commit $TASKS_FILE before starting" >&2
  echo "  (a park runs 'git clean -fd'; with nothing tracked, that deletes the checklist)" >&2
  exit 1
}

# Ignore this script's own log files locally (.git/info/exclude), not the
# project's tracked .gitignore. A *tracked* .gitignore entry for the same
# path makes an explicit `git add -A -- . ':!path'` exit non-zero (git's
# "ignored paths" advisory fires even though the exclude pathspec correctly
# keeps it unstaged) -- and that non-zero exit silently skips the `&&
# git commit` that follows. Plain `git add -A` with no explicit pathspec
# always skips an ignored file cleanly, exit 0, regardless of which
# mechanism ignores it -- so ignore locally and never pathspec-exclude.
#
# .kodr/ is on the same list for a related but worse reason. Kodr writes a run
# transcript there per attempt, *during* the attempt. Unignored, a green task
# swept a few hundred lines of JSON conversation into every commit -- and a
# parked attempt's record was still untracked when the park path's `git clean
# -fd` ran, so it was deleted outright. The attempts that FAILED are the ones
# worth a post-mortem, and they were the only ones being destroyed; the
# successful ones survived as history noise. Ignoring the directory fixes both
# halves at once: `git add -A` skips an ignored path, and `git clean` without
# -x leaves one alone. A relocated runs directory (KODR_RUNS_DIR / --runs-dir)
# is the operator's own to ignore.
mkdir -p "$GIT_DIR/info"
for f in loop.out loop.log .kodr/; do
  grep -qxF "$f" "$GIT_DIR/info/exclude" 2>/dev/null || echo "$f" >> "$GIT_DIR/info/exclude"
done

# First unchecked "- [ ] ..." line, sans the marker. Empty when the backlog is done.
next_task() { grep -m1 '^- \[ \] ' "$TASKS_FILE" 2>/dev/null | sed 's/^- \[ \] //'; }

# A task must be ONE line. next_task is a `grep -m1`, which returns the matching
# line and nothing else -- so an item wrapped onto a continuation line silently
# sends only its first line to the model and drops the rest. Caught live: a
# 15-phase CRM checklist whose every item was wrapped sent phase 0 to the model
# as "Scaffold a zero-dependency Node CRM API: package.json with no" and then
# spent hours building against truncated prompts.
#
# Refuse at startup with the offending line numbers rather than truncate in
# silence. Reflowing wrapped markdown list items in shell is the hazardous
# alternative -- one line per task is the contract instead.
wrapped="$(awk '
  /^- \[[ x!]\] / { item = NR; next }
  item && /^[[:space:]]+[^[:space:]]/ { print item; item = 0; next }
  { item = 0 }
' "$TASKS_FILE")"
if [ -n "$wrapped" ]; then
  echo "$TASKS_FILE: these checklist items wrap onto a continuation line:" >&2
  echo "$wrapped" | sed 's/^/  line /' >&2
  echo "  Each task must be a single line -- only the first line is ever sent to the model." >&2
  exit 1
fi

# Flip the FIRST unchecked line's marker to $1 (x = done, ! = blocked). Portable
# awk rewrite — next_task always hands us the first unchecked line, so "first" is
# unambiguous within one iteration.
mark_first() {
  awk -v m="$1" '
    !done && /^- \[ \] / { sub(/^- \[ \] /, "- [" m "] "); done=1 }
    { print }
  ' "$TASKS_FILE" > "$TASKS_FILE.tmp" && mv "$TASKS_FILE.tmp" "$TASKS_FILE"
}

# Wipe each configured RESET_PATHS entry. Only called after `git reset --hard`,
# so this only ever throws away the abandoned attempt's own gitignored state,
# never a still-current commit's. A few egregious footguns are refused outright
# rather than validated in depth — RESET_PATHS is operator-set, not model output.
# `set -f` while splitting: RESET_PATHS is intentionally unquoted so multiple
# paths word-split, but an unquoted "*" would otherwise glob-expand to every
# file in cwd and rm -rf the whole tree — noglob keeps each entry literal.
reset_paths() {
  set -f
  for p in $RESET_PATHS; do
    case "$p" in
      .|..|.git|/*|../*|*/..|*/../*) echo "  RESET_PATHS: refusing to rm -rf '$p'" >&2; continue ;;
    esac
    if [ -d "$p" ]; then
      # Recreate as an empty directory, not just gone — a storage layer that
      # opens a db file inside it (e.g. `new DatabaseSync('data/crm.db')`)
      # typically assumes the directory itself already exists and never
      # mkdir's it; leaving it entirely missing turned "wipe the database"
      # into "break every later phase's tests until something recreates it
      # by hand," found live on a run using RESET_PATHS=data.
      rm -rf -- "$p"
      mkdir -p -- "$p"
    elif [ -e "$p" ]; then
      rm -rf -- "$p"
    fi
  done
  set +f
}

test_args=()
[ -n "$TEST_CMD" ] && test_args=(--test "$TEST_CMD")
timeout_args=()
[ -n "${REQUEST_TIMEOUT_MS:-}" ] && timeout_args=(--request-timeout-ms "$REQUEST_TIMEOUT_MS")

while task="$(next_task)"; [ -n "$task" ]; do
  echo "=== $task"
  attempt=0; cont=(); green=false
  while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    out="$(kodr run "$task" "${test_args[@]}" \
             --memory --memory-auto-apply \
             --max-tool-turns "$TOOL_TURNS" --max-run-ms "$RUN_MS" \
             "${timeout_args[@]}" \
             --json --no-fail "${cont[@]}")"
    # Done = completed AND actually changed something (not a no-op completion)
    # AND verification did not fail. noOpCompletion guards a "complete" run that
    # quietly did nothing — otherwise indistinguishable from real success.
    green="$(printf '%s' "$out" | jq -r '.completed and (.noOpCompletion | not) and (.verified != false)')"
    [ "$green" = "true" ] && break
    stopped="$(printf '%s' "$out" | jq -r '.stoppedReason // "unknown"')"
    echo "  attempt $attempt not green ($stopped) → --continue"
    cont=(--continue last)   # retry in place; keep the broken state for the model
    if [ "$stopped" = "error" ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "  transient error, backing off ${RETRY_BACKOFF_S}s before retry"
      sleep "$RETRY_BACKOFF_S"
    fi
  done

  if [ "$green" = "true" ]; then
    # Mark first, commit second — the checklist tick rides in the same commit
    # as the code, so it survives any later task's `git reset --hard`. (A
    # commit-then-mark order leaves the tick uncommitted, and a later park's
    # reset silently reverts this task back to unchecked — it gets redone.)
    mark_first x
    # loop.out/loop.log are locally ignored (see GIT_DIR setup above), so
    # this plain `git add -A` never sweeps them in — no pathspec exclusion.
    if ! { git add -A && git commit -q -m "kodr: $task"; }; then
      echo "  ERROR: git commit failed after a green build — stopping; workspace may be inconsistent, inspect by hand" >&2
      exit 1
    fi
    echo "  committed."
  else
    echo "  PARKED after $MAX_ATTEMPTS attempts" | tee -a loop.log
    git reset --hard -q      # discard the failed attempt; keep the tree green
    # ...but git reset --hard only reverts *tracked* files -- a stray new file
    # the attempt created (e.g. a test file for the entity it never finished)
    # survives untracked, and `node --test`-style runners auto-discover every
    # test file regardless of tracking, so debris here silently fails the
    # *next* task's verification for a reason that has nothing to do with it.
    # git clean respects .gitignore (no -x), so this doesn't touch data/ or
    # any other gitignored path -- that's RESET_PATHS's job, not this one's.
    git clean -fd -q
    reset_paths               # ...and any gitignored state it touched (opt-in, see RESET_PATHS)
    mark_first '!'
    # Commit the park mark on its own — same reason as above, but the mark
    # has to happen after the reset here, so it needs its own tiny commit
    # instead of riding along with one that already happened.
    if ! { git add "$TASKS_FILE" && git commit -q -m "kodr: park $task"; }; then
      echo "  ERROR: failed to commit the park mark — stopping; a later park's reset could silently un-park this task" >&2
      exit 1
    fi
    if [ "$STOP_ON_PARK" != "0" ]; then
      # Stop rather than carry on. A checklist is ordered, and a later item
      # usually builds on an earlier one -- so continuing past a park means
      # every remaining item is built against a foundation that was just
      # reverted. Caught live: a CRM plan parked its Notes/Tasks phase, and the
      # next phase (a judged, build-plus-judge-per-attempt one) spent itself
      # retrofitting ownership scoping across "companies, contacts, deals,
      # notes, tasks" with the last two nonexistent. The park is committed
      # first, so relaunching resumes cleanly at the first unchecked item.
      echo "  stopping after a park -- later tasks build on this one." >&2
      echo "  Fix it by hand or reword the checklist line, then relaunch." >&2
      echo "  (STOP_ON_PARK=0 to carry on to the next task instead)" >&2
      exit 1
    fi
  fi
done

echo "backlog empty."
kodr stats
