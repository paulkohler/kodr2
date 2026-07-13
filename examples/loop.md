# Looping Kodr over a backlog

Kodr is a one-shot harness — one `kodr run` is one task. To make it work
*continuously*, you wrap it in an outer loop. Kodr deliberately doesn't build the
loop in (zero runtime deps, one job done well); instead it exposes the seams a
loop needs, and the loop is an ordinary shell script. [`loop.sh`](./loop.sh) is a
runnable one.

## The two seams

- **Exit code** — `kodr run` exits `0` only when the run reached `complete` *and*
  verification didn't fail. So `if kodr run …; then` branches on success. `--no-fail`
  forces exit `0` when you'd rather read the outcome from JSON than have the shell die.
- **`--json`** — one machine-readable line per run:
  `{ completed, verified, noOpCompletion, filesChanged, toolTurns, usage, retries, stoppedReason, … }`.
  Everything the loop needs to decide *done / retry / park*, no output scraping.

## How the agent carries progress across iterations

Three channels, different in kind:

1. **The workspace** — git-committed code. The durable substrate the next iteration reads.
2. **`--continue last`** — replays the previous run's transcript so the model sees what it just tried (short-term working memory).
3. **`MEMORY.md`** — the end-of-run retrospective (`--memory`), injected into every future run's system prompt (long-term, human-reviewable memory; `--memory-auto-apply` lets an unattended loop accumulate it).

What keeps iteration *monotonic* is the **verify-gated commit-on-green ratchet**: only a
`complete + changed + verified` state is committed. A red attempt heals in-run (up to
`--heal-turns`), then retries across runs with `--continue` (broken code stays on disk to
fix); only on giving up does the loop `git reset --hard` and mark the task blocked. Because
`.kodr/runs/` lives outside git, transcripts survive a revert — so you *continue* a
retry-in-place, and *start fresh* after a revert-and-park.

## Run it

Write a `TASKS.md` checklist, then:

```bash
# defaults: MAX_ATTEMPTS=3, TEST_CMD="npm test"
./examples/loop.sh

# override
MAX_ATTEMPTS=5 TEST_CMD="node --test" ./examples/loop.sh
```

```markdown
<!-- TASKS.md -->
- [ ] add input validation to server.mjs
- [ ] write a test for the empty-input case
- [ ] document the new option in the README
```

Green tasks flip to `- [x]`, parked ones to `- [!]`. `kodr stats` at the end shows the
heal / retry / verify rates across the night. `jq` is the loop's dependency, not Kodr's.

For long runs, launch detached — `nohup ./examples/loop.sh >loop.out 2>&1 & disown` —
rather than a foreground shell that may be culled, and drive scheduling from
`cron`/`launchd` if you want it recurring.

## Where this falls short

The loop's stop condition is a shell test command — fine for "tests pass", useless for a
*fuzzy* goal ("the docs read clearly", "Lighthouse ≥ 90"), and it can't tell real progress
from thrashing on its own. That's what [`kodr goal`](../specs/goal.yaml) adds: iterate until
a **model judge** says the goal is met, capped at N attempts.
