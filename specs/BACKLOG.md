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

### #4 — [MED] A 200 response that isn't SSE is swallowed as a successful empty completion
- **Where:** `src/model.mjs` streaming parse (`parseSseLine` returns null for any
  non-`data:` line; a 200 with a plain-JSON body yields zero chunks).
- **Repro:** A provider/proxy returns HTTP 200 with a non-streaming JSON body (or
  a 200-wrapped error). No chunks assemble, so the message is empty with usage
  `{0,0,0}`; the loop sees no tool calls or text and reports `stoppedReason:
  'complete'` — a "successful" run that did nothing. Partly masked by the
  `noOpCompletion` notice.
- **Fix direction:** If a 200 stream produced no parseable chunks and no
  `[DONE]`, treat it as a malformed-response error.

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
- **#5** compaction never fired when the provider omitted usage (Ollama) — `90cc232`
- **#6** sparse `tool_calls` (skipped stream index) crashed the loop — `424deb7`

## Audited and found solid (no action)

Shell timeout / orphan-kill escalation, tool-recovery brace scanning, path
jail, the heal loop, and HTTP retry classification.
