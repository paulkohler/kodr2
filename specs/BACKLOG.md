# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

- **#12** the model marking the checklist itself halts the whole loop, and a
  green phase's work is left uncommitted. `markTaskAt` (`src/loop.mjs:251`)
  refuses any line that is not still `- [ ] ` and the loop turns that into a
  `mark-failed` stop. That guard is the #8 fix and it should stay — a mark
  written onto the wrong task is worse. But it also fires on the harmless
  case: the model writing *the very mark the loop was about to write*.

  Found in the second CRM dogfooding run (`CRM-RUN-2-NOTES.md`), which ended
  `kodr loop: mark-failed (green 2, parked 0)` at phase 3 of 15 after 83
  minutes. Phase 2 finished green — `verify: pass`, 68 tests green twice, 30
  of them new — and the run stopped without committing any of it, leaving the
  work uncommitted in the tree. The cause, in the model's own words from the
  log: "Everything checks out. Marking the phase complete in `TASKS.md`
  (consistent with how prior phases were recorded)", then `edit_file
  TASKS.md`. It had seen phases 0 and 1 recorded as `- [x]` and copied the
  convention. Nothing in `AGENTS.md`, the system prompt or the skills says
  the checklist belongs to the harness. The harness recorded the evidence
  itself: the task entry's `filesChanged` lists `TASKS.md`.

  Same shape as #8 — a model-authored edit defeating a loop mechanism — by a
  different route. #8 was a `git commit`, this is the checklist.

  Three candidate fixes, probably more than one of them:
  - Make the mark idempotent: if the line at the remembered index is the same
    task and already carries the mark the loop intended, that is success, not
    a refusal. A *different* mark, different text, or a moved line still
    stops. `checklistAdapter` already has the task text from `readNextTask`;
    it just doesn't pass it to `markTask`.
  - Tell the model the checklist is not its to edit, in
    `examples/crm/AGENTS.md` and in the loop's own system prompt.
  - Have the loop refuse the model write to the tasks file outright while it
    is driving that file.

- **#13** `kodr loop` prints no per-task marker, so an unattended run is
  opaque while it matters. No "starting task 3 of 15", no per-phase
  green/parked line — only one tally at the very end
  (`kodr loop: <reason> (green N, parked M)`). The sole progress signal on
  stdout is the ANSI-coloured `note context window ...` line at each
  attempt's start, and it cannot distinguish the next phase from a retry of
  the current one, which is the single thing an operator most wants to know.
  Telling them apart during the run above meant shelling into the sandbox to
  read `git log` and `TASKS.md`. The data is all there — the loop knows the
  task index, the attempt number and the previous phase's verdict — it just
  never says any of it.

## Fixed

- **#11** a cleanly-detached child outlived the run — `killTree` ran only
  from inside `runShell`, on output overflow, timeout and abort, so a command
  that *succeeds* having detached something was reaped by nothing. Every
  group the runner creates is now registered and dropped again at close once
  it is empty (one `kill(-pgid, 0)` syscall, not a `ps` fork), and the run
  sweeps whatever is left before it exits — SIGTERM, then SIGKILL after
  `--sweep-grace-ms` — reporting what it killed on stderr whether or not
  `--keep-orphans` spared it. Found live, and not by adversarial prompting:
  asked only to background a server and curl it, `qwen3.8-27b-mlx` hit the
  #9 timeout reaping, diagnosed it correctly ("the background job inherited
  the output pipe, so the command never finished"), and routed around it
  unprompted on its next tool call with
  `nohup node server.mjs > /dev/null 2>&1 &` — exit 0 in 7ms, no timeout to
  fire, server still answering after the run. The silence was the worse half
- **#10** a provider outage parked the task as though the model had failed
  it — a task whose *every* attempt ends stoppedReason "error" is no longer
  marked `[!]`: the tree is still rewound, the line is left `[ ]`, and the
  loop stops with reason `attempts-errored` so a rerun resumes the same task
  with nothing to hand-undo. Found in the CRM dogfooding run
  (`examples/crm/TASKS.md`): phase 1's three attempts were all HTTP 500 from
  a healthy LM Studio, ten seconds end to end, and the phase was retired
  permanently for it. A task that errors once and then fails its gate still
  parks — it got a fair attempt
- **#9** a backgrounded command's orphan survived the timeout — the runner
  now spawns into its own process group and signals the group (`execFile`
  silently drops `detached`, which is why the group never existed), with the
  ppid walk kept as a fallback and an AbortSignal plumbed through so Ctrl-C
  still reaches a detached command
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
