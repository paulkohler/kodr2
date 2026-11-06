# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

- **#8** a model-authored `git commit` defeats the park path, mismarking the
  checklist. Two independent faults compound. `markTask` flips *the first
  unchecked line* (`loop.mjs:211`, `loop.mjs:231`) rather than the line
  `nextTask` returned, and the park sequence runs a bare `git reset --hard`
  (`loop-git.mjs:273`), which resets to *current* HEAD with no pre-attempt
  snapshot. So when the model commits its own work mid-attempt — which a
  capable model will do unprompted, having read the `kodr: ` convention out of
  `git log` — that commit survives the park, and the `[!]` mark lands on the
  *next* task instead of the one that failed. Observed 2026-11-07 with
  qwen3.8-27b-mlx and a forced-failing gate (`--test false --max-attempts 1`):
  the `max` task was left `- [x] ` with its work committed although the gate
  rejected it, while `- [!] ` landed on `median`, never attempted. The park
  commit and the loop record both name `max`, so the checklist, history and
  record disagree about what happened. Surfaced while testing kodr inside an
  OpenShell sandbox, but neither fault involves the sandbox: both are host-side
  and should reproduce anywhere. Likely fix — capture `git rev-parse HEAD`
  before each attempt and reset to that sha on park, and mark by the line index
  `nextTask` consumed rather than re-scanning for the first unchecked line.

## Fixed

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
