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
# Requirements: same as loop.sh — kodr on PATH, `jq`, a git repo, and bash >=
# 4.4 (an empty array expansion like "${cont[@]}" under `set -u` is an
# unbound-variable error on older bash, e.g. macOS's preinstalled /bin/bash
# 3.2 -- make sure `env bash` resolves to something newer, such as
# Homebrew's). For an overnight run, launch it detached (`nohup
# ./examples/phased-loop.sh >phased-loop.out 2>&1 & disown`) rather than in
# a foreground shell that may be culled — a 15-phase checklist with a
# couple of GOAL: items easily runs for hours.
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
#   REQUEST_TIMEOUT_MS per-HTTP-request ceiling passed to kodr's --request-timeout-ms;
#                      unset leaves kodr's own default (600000 = 10m). A large local
#                      model under load can outrun 10 minutes on a single request well
#                      before RUN_MS's own budget is used up — raise this alongside
#                      RUN_MS for a big overnight run rather than leaving it implicit.
#   RETRY_BACKOFF_S    seconds to sleep before retrying a plain task's attempt that
#                      ended with stoppedReason "error" (a transient backend failure --
#                      an LM Studio HTTP 500 or a request timeout -- not a genuine
#                      build/test failure). Default 5. Only covers the plain-task
#                      branch's own retry loop; a GOAL: item's internal attempts are
#                      kodr goal's own loop and aren't backed off by this script.
#   RESET_PATHS        space-separated gitignored paths (e.g. "data") to `rm -rf` on
#                      park, alongside `git reset --hard`. Empty/unset by default --
#                      `git reset --hard` only reverts *tracked* files, so a database
#                      or cache dir an abandoned phase migrated/mutated survives the
#                      park untouched, silently carrying that phase's damage forward
#                      into every later phase. A live run of this exact checklist left
#                      three separate parked phases' schema changes (owner_id columns,
#                      a users table, organization_id columns) permanently baked into
#                      data/crm.db, with zero trace in any committed source file. Opt
#                      in per project once you know which paths are safe to wipe.
set -uo pipefail

MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
GOAL_MAX_ATTEMPTS=${GOAL_MAX_ATTEMPTS:-4}
TEST_CMD=${TEST_CMD:-npm test}
TASKS_FILE=${TASKS_FILE:-TASKS.md}
TOOL_TURNS=${TOOL_TURNS:-30}
RUN_MS=${RUN_MS:-900000}
RETRY_BACKOFF_S=${RETRY_BACKOFF_S:-5}
RESET_PATHS=${RESET_PATHS:-}

command -v kodr >/dev/null || { echo "kodr not on PATH" >&2; exit 1; }
command -v jq   >/dev/null || { echo "jq not on PATH (needed by this loop)" >&2; exit 1; }
[ -f "$TASKS_FILE" ] || { echo "no $TASKS_FILE" >&2; exit 1; }
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || { echo "not a git repo" >&2; exit 1; }

# Ignore this script's own log files locally (.git/info/exclude), not the
# project's tracked .gitignore. A *tracked* .gitignore entry for the same
# path makes an explicit `git add -A -- . ':!path'` exit non-zero (git's
# "ignored paths" advisory fires even though the exclude pathspec correctly
# keeps it unstaged) -- and that non-zero exit silently skips the `&&
# git commit` that follows. Plain `git add -A` with no explicit pathspec
# always skips an ignored file cleanly, exit 0, regardless of which
# mechanism ignores it -- so ignore locally and never pathspec-exclude.
mkdir -p "$GIT_DIR/info"
for f in phased-loop.out phased-loop.log; do
  grep -qxF "$f" "$GIT_DIR/info/exclude" 2>/dev/null || echo "$f" >> "$GIT_DIR/info/exclude"
done

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
  green=false
  park_note="PARKED after $MAX_ATTEMPTS attempts"

  if [[ "$task" == "GOAL: "* ]]; then
    condition="${task#"GOAL: "}"
    out="$(kodr goal "$condition" "${test_args[@]}" \
             --max-attempts "$GOAL_MAX_ATTEMPTS" \
             --max-tool-turns "$TOOL_TURNS" --max-run-ms "$RUN_MS" \
             "${timeout_args[@]}" \
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
               "${timeout_args[@]}" \
               --json --no-fail "${cont[@]}")"
      # Done = completed AND actually changed something (not a no-op
      # completion) AND verification did not fail. noOpCompletion guards a
      # "complete" run that quietly did nothing — otherwise indistinguishable
      # from real success.
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
  fi

  if [ "$green" = "true" ]; then
    # Mark first, commit second — the checklist tick rides in the same commit
    # as the code, so it survives any later task's `git reset --hard`. (A
    # commit-then-mark order leaves the tick uncommitted, and a later park's
    # reset silently reverts this task back to unchecked — it gets redone.)
    mark_first x
    # phased-loop.out/phased-loop.log are locally ignored (see GIT_DIR setup
    # above), so this plain `git add -A` never sweeps them in — no pathspec
    # exclusion. (An earlier version used `git add -A -- . ':!path'` instead
    # of a local ignore; combined with also listing these files in the
    # project's own tracked .gitignore, that pathspec form made `git add`
    # exit non-zero on git's "ignored paths" advisory, which silently
    # skipped every commit via `&&` — a live run built five phases' worth of
    # work before that surfaced, since mark_first still advanced the
    # checklist in the working tree with nothing ever actually committed.)
    if ! { git add -A && git commit -q -m "kodr: $task"; }; then
      echo "  ERROR: git commit failed after a green build — stopping; workspace may be inconsistent, inspect by hand" >&2
      exit 1
    fi
    echo "  committed."
  else
    echo "  $park_note" | tee -a phased-loop.log
    git reset --hard -q      # discard the failed attempt(s); keep the tree green
    # ...but git reset --hard only reverts *tracked* files -- a stray new file
    # the attempt created (e.g. a test file for the entity it never finished)
    # survives untracked, and `node --test`-style runners auto-discover every
    # test file regardless of tracking, so debris here silently fails the
    # *next* phase's verification for a reason that has nothing to do with
    # it. A live run hit exactly this: a park left an untracked test file
    # behind that asserted against routes the reset had just removed, and it
    # would have failed the following phase's `npm test` outright. git clean
    # respects .gitignore (no -x), so this doesn't touch data/ or any other
    # gitignored path -- that's RESET_PATHS's job, not this one's.
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
  fi
done

echo "backlog empty."
kodr stats
