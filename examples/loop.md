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

# a big local model can outrun the 10-minute default per-request ceiling well
# before RUN_MS's own budget is used up; raise both for a long overnight run
RUN_MS=1800000 REQUEST_TIMEOUT_MS=1200000 ./examples/loop.sh
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

`loop.out`/`loop.log` are never tracked, so they're never touched by a park's
`git reset --hard`. An earlier version swept them in like any other file: a park
would silently discard whatever they'd accumulated since the last green commit,
since only `TASKS_FILE` gets a dedicated re-commit after a park — a long run with
a few parks in a row would leave the human-facing log frozen well before the run
actually stopped. The script keeps them untracked by appending their names to
`.git/info/exclude` (a repo-local ignore list, not the project's own tracked
`.gitignore`) once at startup, then using a plain `git add -A`. Don't add these
filenames to the project's own `.gitignore` as well — an *explicit* pathspec
exclusion (`git add -A -- . ':!loop.out'`) combined with a tracked `.gitignore`
entry for the same path makes `git add` exit non-zero on git's own "ignored
paths" advisory, which used to silently skip the `&& git commit` that followed
it. That regression shipped for one run before it was caught: five phases built
correctly but never got committed, because `mark_first` had already advanced the
checklist in the working tree regardless. The script now commits with plain
`git add -A` (no explicit pathspec) precisely so this can't recur, and stops
outright with a clear error if a commit ever fails after a green build, rather
than silently continuing on a false assumption.

An attempt that ends with `stoppedReason: "error"` (an LM Studio HTTP 500, a
request timeout) gets a `RETRY_BACKOFF_S`-second pause (default 5) before the next
attempt — retrying a transient infra hiccup instantly tends to just hit the same
hiccup again. A genuine build/test failure gets no delay; the model has to act, not
wait.

A park also runs `git clean -fd` right after `git reset --hard`. The reset only
reverts *tracked* files — a stray new file the attempt created (a test file for
an entity it never finished, say) survives untracked, and a `node --test`-style
runner auto-discovers every test file regardless of tracking, so that debris
silently fails the *next* task's verification for a reason that has nothing to
do with it. `git clean -fd` respects `.gitignore` (no `-x`), so it doesn't touch
`data/` or anything else already ignored — that's `RESET_PATHS` below, a
different job. Note this means the working tree is assumed to be exclusively
this script's during a run — don't hand-edit files alongside it, the same way
you already wouldn't with `git reset --hard` in play.

`git reset --hard` only reverts *tracked* files — a database or cache directory an
abandoned attempt migrated or seeded survives a park untouched, silently carrying
that attempt's damage into every later task. `RESET_PATHS` (space-separated,
empty/unset by default) names gitignored paths to `rm -rf` alongside the reset —
e.g. `RESET_PATHS=data ./examples/loop.sh`. Off by default: it's destructive, and
only the operator knows which paths are actually safe to blow away and recreated
on demand.

If a listed path was a directory, it's recreated empty right after the wipe, not
just left gone — a storage layer that opens a db file inside it typically assumes
the directory itself already exists and never `mkdir`s it, so leaving it entirely
missing turns "wipe the database" into "every later task's tests fail with
`unable to open database file` until something recreates the directory by hand."
Found live: a run with `RESET_PATHS=data` correctly wiped a SQLite-backed CRM's
`data/` on a park, and every subsequent phase failed for exactly that reason.

## Where this falls short

The loop's stop condition is a shell test command — fine for "tests pass", useless for a
*fuzzy* goal ("the docs read clearly", "Lighthouse ≥ 90"), and it can't tell real progress
from thrashing on its own. That's what [`kodr goal`](../specs/goal.yaml) adds: iterate until
a **model judge** says the goal is met, capped at N attempts.
