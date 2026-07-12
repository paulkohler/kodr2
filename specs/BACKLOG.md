# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

None — every finding from the 2026-07-10 audit is fixed. New issues go here.

## Follow-ups (planning phase, specs/planning.yaml)

Deliberate v1 scope cuts, not bugs:

- **Planner exploration tools** — an opt-in `--plan-explore` giving the
  planner the review pass's read-only tool set, for plans grounded in the
  actual repo rather than the prompt alone. Cut for planner latency on
  local models.
- **Plan-aware `--continue`** — v1 rejects `--plan` + `--continue`; a
  continuation would need to resume a partially-executed plan from the run
  record's structured plan field.
- **TUI live checklist panel** — v1 shows step transitions in scrollback
  plus a `step i/N` header indicator; a persistent checklist panel needs
  render-region work in tui-render.mjs.
- **Plan-model load sequencing** — a same-provider `--plan-model` on LM
  Studio relies on JIT on-demand loading (plan model loads for the planner
  call, build model loads back on step 1). Kodr-owned load/unload/verify
  sequencing à la `--review-model` (specs/lms.yaml) would avoid double
  JIT loads and control the context size.
- **Equal-share step budget vs. continuous-investigation tasks** — dogfooding
  (2026-07-11/12, kodr-terminal-bench `vulnerable-secret`) suggests
  `stepRunMs`'s equal-share-with-floor split can starve a step that needs to
  investigate continuously rather than in discrete chunks. Single-sample
  evidence so far — do not special-case `stepRunMs` on it, that mechanism is
  deliberate and spec-documented (specs/planning.yaml) and per-step
  special-casing risks a tri-state/"auto" mode. If a second sample confirms
  it, the lighter-touch lever is a `prompts/plan.md` nudge toward
  single-step plans for investigation-shaped tasks — a single-step plan
  already gets the whole run budget for free, no code change needed.

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
