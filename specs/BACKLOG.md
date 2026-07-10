# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

### #2 — [MED] Near-deadline chat gets a ~1ms timeout, recorded as `error` not `budget-exceeded`
- **Where:** `src/tool-loop.mjs` loop-top budget check (`isRunBudgetExceeded`, `>=`)
  vs `remainingRunBudgetMs` (`Math.max(1, remaining)`); timeout throws in `src/model.mjs`.
- **Repro:** A few ms remain when the loop-top check runs, so it passes; then
  `client.chat` is called with `timeoutMs: ~3`, times out immediately, throws,
  and the run is booked as a hard `error`. A run that merely ran out of
  wall-clock looks like a crash. (Metrics are now preserved after the mid-loop
  fix, but `stoppedReason` is still wrong.)
- **Fix direction:** Require a minimum remaining budget before calling chat
  (treat sub-threshold as `budget-exceeded`), or map a timeout-at-deadline to
  `budget-exceeded`.

### #7 — [LOW] A huge first user message defeats compaction
- **Where:** `src/compact.mjs` `renderTranscript` keeps the first user (task)
  message verbatim while every other message is capped.
- **Repro:** A task with a very large embedded prompt makes the summarize request
  itself exceed the window, so compaction fails and the loop keeps running
  over-window while the backend errors.
- **Fix direction:** Cap the task message too (at a larger bound), or detect an
  over-window transcript and truncate the task with a marker.

## Fixed

- **#1** mid-loop failure zeroed run metrics — `8535040`
- **#3** snapshot cap ignored below the workspace root — `2d4e318`
- **#4** non-SSE 200 swallowed as a successful empty completion — `66fb29c`
- **#5** compaction never fired when the provider omitted usage (Ollama) — `90cc232`
- **#6** sparse `tool_calls` (skipped stream index) crashed the loop — `424deb7`

## Audited and found solid (no action)

Shell timeout / orphan-kill escalation, tool-recovery brace scanning, path
jail, the heal loop, and HTTP retry classification.
