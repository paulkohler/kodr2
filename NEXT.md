# Next

## Diagnosis: parking `--plan` as a proof of concept (2026-07-13)

**Status: parked, not shipped.** This branch (`plan-poc`) holds the entire
`--plan` feature — planner call, per-step sub-agent executor, budget-split
logic, final-step self-check addendum, `degradedReason` observability — as it
stood after a full dogfooding investigation. `main` has been rewound to
`3532649` (immediately before this work started); none of it is reachable
from `main`. This section is the record of *why*.

### The original idea

Decompose a task into a fixed plan of steps up front, each run as its own
sub-agent conversation with its own turn/time budget, on the theory that a
smaller/weaker local model would handle a complex multi-step task better as a
sequence of narrower, more tractable sub-goals than as one long open-ended
tool loop. A final-step addendum (threads A/B, `prompts/plan-step-final.md`)
was later added so the last step would check the *overall* goal, not just its
own narrow slice, and actually run the workflow it built rather than just
reasoning about it.

### What the dogfooding actually showed

All findings below are backed by real Terminal-Bench runs; see
`../kodr-terminal-bench/RESULTS.md` for full transcripts and per-run detail.

1. **No demonstrated net pass-rate improvement over the plain single-loop
   mode**, on every model/task combination where a direct `--plan` vs
   no-`--plan` comparison was actually run. The cleanest evidence is the
   2026-07-12 three-task batch (`sanitize-git-repo`,
   `multi-source-data-merger`, `crack-7z-hash`, `google/gemma-4-26b-a4b`,
   256k context, matched turn/time budgets): **`--plan` reproduced the exact
   same pass/fail outcome as no-`--plan` on all 3 tasks** (0/0, 1/1, 0/0) —
   zero tasks flipped in either direction. Earlier batches showed the same
   pattern in aggregate (1/4, then 1/3 after budget correction, against a
   3/4 no-`--plan` baseline on the same task family the day before).
2. **The equal-share `stepRunMs` wall-clock split actively hurts tasks that
   are one continuous investigation rather than genuinely separable work.**
   First seen on `vulnerable-secret` (3 steps, 25-minute budget split three
   ways, all three `budget-exceeded`, never past initial probing — the
   unplanned run got further in the same total time by staying in one
   context). Reproduced independently on `crack-7z-hash`: the planner split
   password-cracking into 2 steps, and **both** hit `budget-exceeded`,
   because splitting a single hard investigation into sequential
   budget-starved fragments is strictly worse than giving it one continuous
   budget — each fragment restarts from a synthesized one-line handoff
   instead of the actual accumulated investigative context. This was
   deferred as "Thread C" in `specs/BACKLOG.md` after the first sample;
   the second sample confirms it's systematic, not a fluke.
3. **The final-step self-check addendum (threads A/B) is inconsistent, and
   its net effect across observed runs is neutral-to-negative.** It produced
   one clean win (`git-multibranch`: caught a missing `sshd` start and fully
   repaired it live) but also two new failure modes that didn't exist before
   it was added: over-checking an already-correct file into a lossy rewrite
   (`fix-git`, byte-hash mismatch from an unnecessary `read_file`+`write_file`
   round-trip), and over-scoping into a file the task never asked to be
   touched (`sanitize-git-repo`, plan mode edited `README.md`, which the
   verifier explicitly forbids — the no-`--plan` run made no such edit).
   Broadening the final step's license to act bought one fix and introduced
   at least two new ways to fail.
4. **Planner degradation wipes out any decomposition benefit, and happens
   often enough to matter.** When the planner call itself fails validation
   and falls back to a single generic step, that step gets no step-budget
   benefit at all — it's strictly worse than the non-`--plan` path (extra
   planner-call latency, no upside). `degradedReason` (this branch's own
   fix) made this diagnosable after the fact, but did not make it happen
   less.
5. **Whatever benefit exists is heavily model-gated, in a way that undercuts
   the original motivation.** `qwen/qwen3.6-35b-a3b` passed 3/3 under
   `--plan` with fully-realized final-step self-checks (explicit `sshd`
   diagnosis, `sshpass` install, full SSH+HTTPS verification). The same
   prompts and code against `google/gemma-4-26b-a4b` reproducibly failed the
   same task the same way every time (no `sshd` start attempt, ever). If
   `--plan` mode only pays off on a model that was already going to do fine
   with a single continuous loop, it isn't achieving its stated goal of
   raising the ceiling for weaker local models.

### What's *not* the diagnosis

- Not a testing artifact: the turn-budget confound (kodr2's bare 20-turn
  default silently under-resourcing early `--plan` runs) was identified and
  corrected early, and the findings above all post-date that correction.
- Not a code-quality problem: `src/plan.mjs`, `src/harness.mjs`'s
  `runPlannedBuild`, and their tests are internally consistent and behave
  exactly as designed — `stepRunMs`'s equal-share split and the final step's
  broadened license are both working as specified. The diagnosis is that the
  *design*, not the implementation, doesn't earn its complexity yet.

### Recommendation

Do not merge or enable `--plan` by default. The implementation is preserved
here in case a future task class or model clearly benefits from
decomposition, but revisit only with a different design — e.g., detecting
continuous-investigation-shaped tasks and giving them one undivided step
instead of an equal split, dropping or narrowing the final-step self-check's
edit license back to something closer to read-only verification, or
requiring a demonstrated win on a *weaker* model before counting it as a
net positive at all.

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
