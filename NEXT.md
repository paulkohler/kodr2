# Next

## The plan — investigation closed, no prompt rework needed

Threads A (prescriptive workflow-running) and B (verification-scoped editing)
are implemented, committed, and tested: `prompts/plan-step-final.md`,
`specs/planning.yaml`'s final-step constraint bullet, and the two
`test/plan.test.mjs` assertions all landed across `7eade86`..`3c68911`. Thread C
is deferred in `specs/BACKLOG.md` as designed.

The 2026-07-12 re-dogfood initially hit 1/4 on `google/gemma-4-26b-a4b`
(worse than non-plan mode's 3/4 the day before). Full investigation and
final numbers in `../kodr-terminal-bench/RESULTS.md`. Three suspected causes,
now resolved:

1. **Turn-budget confound (confirmed, no code fix needed).** The re-dogfood
   batch never passed `--max-tool-turns`, so `--plan` mode silently ran at
   kodr2's bare `MAX_TOOL_TURNS=20` default while every non-plan comparison
   run this session used 50-200. Re-running `configure-git-webserver` with
   an explicit 50-turn budget flipped it from a degraded-plan `tool-limit`
   failure to a clean pass with a well-formed 3-step plan. This was a test
   *configuration* gap in `kodr-terminal-bench`, not a kodr2 defect.
2. **Planner-degradation observability (fixed, `307a237`).**
   `Plan.degradedReason` now persists the chat-error/timeout/validation-error
   text into the saved transcript and `--json` summary, closing the same gap
   `stoppedReason`/`filesChanged` were built to close.
3. **Model specificity (confirmed).** A `qwen/qwen3.6-35b-a3b` control run
   passed `git-multibranch`, `configure-git-webserver`, and `fix-git` 3/3
   under `--plan` with the corrected budget — including a final step that
   explicitly started `sshd`, diagnosed an auth failure, installed
   `sshpass`, and verified both the SSH and HTTPS paths end to end, exactly
   the behavior thread A calls for. A final re-dogfood on
   `google/gemma-4-26b-a4b` with the corrected budget still failed
   `git-multibranch` the same way (no `sshd` start attempt, final step
   burned its full turn budget without completing verification) —
   reproducible, not a fluke.

**Conclusion: `prompts/plan-step-final.md` is not reworked.** The 1/4 result
was a test-configuration confound (turn budget) plus a genuine but
model-specific capability gap in `google/gemma-4-26b-a4b`'s self-directed
verification, not a flaw in threads A/B's design — a stronger local model
handles the identical task and prompt correctly. Revisit only if a
stronger/different model shows the same gap.

Also found and fixed along the way (`kodr-terminal-bench` `267c41b`): the
adapter's exec-timeout margin (`max_run_ms` + fixed padding, guarding
against Harbor's own docker-exec timeout firing before Kodr's internal
deadline handling) was too tight at 120s for a large local model's
in-flight-request tail latency — widened to 300s, now overridable via
`KODR_ADAPTER_EXEC_MARGIN_SEC`.
