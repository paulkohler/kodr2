# Next

## The plan — implemented, re-dogfood surfaced new gaps (not yet fixed)

Threads A (prescriptive workflow-running) and B (verification-scoped editing)
are implemented, committed, and tested: `prompts/plan-step-final.md`,
`specs/planning.yaml`'s final-step constraint bullet, and the two
`test/plan.test.mjs` assertions all landed across `7eade86`..`3c68911`. Thread C
is deferred in `specs/BACKLOG.md` as designed.

**Re-dogfood result (2026-07-12, `google/gemma-4-26b-a4b`, full writeup in
`../kodr-terminal-bench/RESULTS.md`): 1/4 pass** — worse than non-plan mode's
3/4 on the same tasks. `fix-git` passed cleanly (thread B's guard held, no
lossy rewrite). `git-multibranch` failed twice and `configure-git-webserver`
once, for three different reasons, none of them a regression in threads A/B
themselves:

1. **Implicit service-startup deps aren't surfaced.** Neither `git-multibranch`
   plan (two different step decompositions) ever started `sshd`, and the
   final-step self-check didn't catch it either — one run's final step never
   attempted the client workflow at all despite the addendum instructing it
   to; the other ran `curl` checks but never `git clone`/`push`, so it
   verified the HTTP delivery path and missed the SSH ingestion path. Thread
   A's "run that exact workflow yourself" isn't reliably running the *whole*
   workflow.
2. **Planner degradation is a black box.** `configure-git-webserver`'s planner
   call failed and fell back to a single generic step (`plan.degraded: true`),
   but `reporter.notice(...)`'s reason isn't persisted anywhere recoverable
   (not in the `--json` summary, not in the saved transcript) — the same
   observability gap `stoppedReason`/`filesChanged` etc. were built to close,
   just not yet extended to the planner path.
3. **A degraded single step gets no step-budget split** and runs at the bare
   `MAX_TOOL_TURNS` default (20) — plausibly too low for a full multi-service
   sysadmin task attempted as one step.

Open question: is this model-specific (weaker instruction-following than
whatever model the original A/B dogfooding used) rather than a prompt-design
flaw? A control run on `qwen/qwen3.6-35b-a3b` would tell us before reworking
threads A/B further.
