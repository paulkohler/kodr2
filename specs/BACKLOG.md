# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

None — #8, #9 and #10 are fixed. New issues go here.

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
