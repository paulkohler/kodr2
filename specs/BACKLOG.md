# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

- **#11** a cleanly-detached child outlives the run, and nothing reaps it.
  `killTree` is only ever called from inside `runShell`, on three paths:
  output overflow, timeout, and abort (`src/shell.mjs`). A command that
  *succeeds* having detached something is reaped by none of them, and no
  other part of the harness sweeps children at end of run — so the process
  survives `kodr` exiting and keeps whatever port it holds. Same consequence
  as #9 by a route the fix does not cover; `specs/shell.yaml`'s "Known limit"
  bullet names `setsid` but not this.

  Not hypothetical, and not something a model has to be talked into. Asked
  only to start a server in the background and curl it,
  `qwen3.8-27b-mlx` hit the #9 timeout reaping, diagnosed it correctly
  ("the background job inherited the output pipe, so the command never
  finished"), and routed around it unprompted on its next tool call with
  `nohup node server.mjs > /dev/null 2>&1 &`. The redirect closes the pipes
  and `&` backgrounds it, so `sh` exits 0 in 7ms; there is no timeout to
  fire. Verified on the host with a direct `runShell` probe: exit 0, and the
  server still answering afterwards.

  Contained inside an OpenShell sandbox, since the sandbox is deleted at run
  end — an incidental point in the sandbox's favour. On the host it is a real
  leak.

  The fix is a design call, not an obvious patch: sweeping the run's process
  group at exit would also kill a dev server the operator deliberately asked
  for, so it probably wants to be opt-out, and at minimum the run should
  report what it left running instead of leaving it silent.

## Fixed

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
