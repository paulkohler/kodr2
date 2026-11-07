# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

- **#9** a backgrounded command's orphan survives the timeout. The hang it
  used to cause is fixed (the timeout now answers the caller itself, see
  `specs/shell.yaml`), but nothing kills the process. `sh -c "cargo run &"`
  exits immediately, so the server is reparented to init *before* the timeout
  fires, and `descendantPids` walks `ps -Ao pid,ppid` down from the direct
  child — a process that is no longer anyone's descendant cannot be found that
  way at any snapshot moment. This is the second time the area has bitten:
  `2843873` ("make timeout kill the whole command tree") fixed the live-tree
  case (`npm` → `node --test`) and reasoned about reparenting happening *after*
  SIGTERM; with `&` it happens first, which that design cannot reach.
  Consequence today: a leaked process holding a port or burning CPU for the
  rest of the session, and node's own handle stays open on the inherited pipes
  until it exits.

  The fix that would actually work is a process group: spawn with
  `detached: true` so `sh` becomes a group leader, then `process.kill(-pid)` at
  timeout, keeping the ppid walk as a fallback for hosts that silently refuse
  to create a group (the concern `specs/shell.yaml` records for rejecting
  groups originally — try-and-fall-back answers it, since a group id that was
  never created simply ESRCHes). The reason this is filed rather than done:
  `detached: true` also detaches the child from the terminal's process group,
  so a Ctrl-C in the TUI would stop reaching an in-flight command. Doing it
  safely means giving `runShell` an optional AbortSignal and killing the group
  on abort, which is a change to the cancellation seam (`specs/cancel.yaml`)
  and worth its own pass. Note `runShell` takes no signal today — cancellation
  works between tool-loop turns — so that plumbing is new surface, not a
  rewire.

## Fixed

- **#8** a model-authored `git commit` defeated the park path, mismarking
  the checklist — park now rewinds to the sha HEAD had before the attempt
  and the mark lands on the line index `readNextTask` returned, with a
  `mark-failed` stop when that line moved under the loop
- **#1** mid-loop failure zeroed run metrics — `8535040`
- **#2** near-deadline timeout mislabeled `error` vs `budget-exceeded` — `638e485`
- **#3** snapshot cap ignored below the workspace root — `2d4e318`
- **#4** non-SSE 200 swallowed as a successful empty completion — `66fb29c`
- **#5** compaction never fired when the provider omitted usage (Ollama) — `90cc232`
- **#6** sparse `tool_calls` (skipped stream index) crashed the loop — `424deb7`
- **#7** huge first user message defeated compaction (task now capped) — `9a44a75`

## Audited and found solid (no action)

Shell timeout / orphan-kill escalation, tool-recovery brace scanning, path
jail, the heal loop, and HTTP retry classification.
