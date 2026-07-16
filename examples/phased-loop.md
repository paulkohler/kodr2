# Looping Kodr over a checklist that mixes tests and judgment

[`loop.sh`](./loop.md) drives Kodr over a `TASKS.md` checklist, one line at a
time, gated by a test command. That's the right tool for most of a real
build. It's the wrong tool for a phase whose "done" is a claim about the
*whole* codebase — "every endpoint has an owner check," "the README
documents every endpoint" — because no shell command can check a totality
claim like that, only read the code and judge it. That's what
[`kodr goal`](../specs/goal.yaml) is for: iterate build → test → a read-only
model judge, until the judge says `MET`.

[`phased-loop.sh`](./phased-loop.sh) is `loop.sh` with one branch added, so a
single checklist can use both constructs where each one actually earns its
keep, instead of picking one for the whole plan.

## The convention

A checklist line is either:

```markdown
- [ ] add input validation to server.mjs
```

— a plain task, run with `kodr run "<line>" --test "$TEST_CMD"`, retried up
to `MAX_ATTEMPTS` times with `--continue last` between attempts (identical to
`loop.sh`) — or:

```markdown
- [ ] GOAL: every existing endpoint has an owner check retrofitted onto it
```

— a `GOAL: ` line, run with
`kodr goal "<line minus the prefix>" --test "$TEST_CMD" --max-attempts "$GOAL_MAX_ATTEMPTS"`.

The two are gated differently on purpose:

| | plain task | `GOAL:` line |
|---|---|---|
| gate | `.completed and !.noOpCompletion and (.verified != false)` | `.met and (.filesChanged\|length > 0) and (.verified != false)` |
| retries | this script's own outer loop, `--continue last` between attempts | `kodr goal`'s own internal build+judge attempts, with its own continuation |
| cost model | one build per attempt | one build **and one judge assessment** per attempt |

A `GOAL:` item is never wrapped in this script's own outer retry loop — `kodr
goal` already *is* an attempt loop, with its own continuation between
attempts. Re-running a failed goal fresh from this script would just repeat
the same attempts with no memory of what the judge already said, so on a
non-met result the item goes straight to parked.

## Why the split matters

A test suite can be green and the feature can still be wrong — see
[`examples/crm-phases.md`](./crm-phases.md)'s phase 7, `/search-all`: a real
run of that exact feature shipped with one whole entity silently missing
from the search results, fully documented and fully tested as if it were
complete. The tests passing was never in question; whether the model
actually covered everything it claimed to was. That's the gap a grounded
judge closes and a test command structurally cannot.

The reverse mistake is just as real: routing *everything* through `kodr
goal` would burn a build-time judge assessment on tasks a test command
already settles for free — "add input validation" doesn't need a model to
read the diff and confirm it exists; the test suite already proves it. The
`crm-phases.md` example keeps `GOAL:` to four of its fifteen phases —
the ones that are claims about the whole codebase (auth retrofit, hardening,
multi-tenancy) or where "tests are green" has already been seen to lie
(search-all) — and leaves the rest as plain tasks.

## Run it

```bash
mkdir -p /path/to/a/throwaway/crm && cd /path/to/a/throwaway/crm
git init -q
cp /path/to/kodr2/examples/crm-phases.md TASKS.md

# defaults: MAX_ATTEMPTS=3, GOAL_MAX_ATTEMPTS=4, TEST_CMD="npm test"
/path/to/kodr2/examples/phased-loop.sh

# override
GOAL_MAX_ATTEMPTS=6 RUN_MS=1800000 /path/to/kodr2/examples/phased-loop.sh

# a big local model can outrun the 10-minute default per-request ceiling well
# before RUN_MS's own budget is used up; raise both for a long overnight run
RUN_MS=1800000 REQUEST_TIMEOUT_MS=1200000 /path/to/kodr2/examples/phased-loop.sh
```

Green items flip to `- [x]`, parked ones to `- [!]` — same convention as
`loop.sh`. `kodr stats` at the end shows heal/retry/verify/compaction rates
across the whole run, plain tasks and goals together.

For long runs, launch detached —
`nohup ./examples/phased-loop.sh >phased-loop.out 2>&1 & disown` — the same
advice `loop.sh` gives, more true here: a fifteen-phase plan with four
judged phases on top is a multi-hour run even on a fast local model.

`phased-loop.out`/`phased-loop.log` are never tracked — never touched by a
park's `git reset --hard`. A live 15-phase, ~5-hour run of this exact
checklist caught the bug this fixes: both files froze after the first
success, holding only their first few lines, because every park after that
silently discarded whatever they'd accumulated since (only `TASKS_FILE`
gets a dedicated re-commit on park) — the log looked like the run had died
within minutes when it had actually kept going correctly for hours. The
script keeps them untracked by appending their names to `.git/info/exclude`
(repo-local, not the project's tracked `.gitignore`) once at startup, then
committing with a plain `git add -A`.

**Don't also add these filenames to the project's own `.gitignore`.** A
second live run did exactly that, and it's worse than the original bug: an
explicit pathspec exclusion (`git add -A -- . ':!phased-loop.out'`)
combined with a *tracked* `.gitignore` entry for the same path makes `git
add` exit non-zero on git's own "ignored paths" advisory — even though the
exclude pathspec correctly kept the file unstaged — and that non-zero exit
silently skipped the `&& git commit` that followed it, for every single
task. Five phases built correctly in that run and were never committed;
`mark_first` had already advanced the checklist in the working tree
regardless, so the loop kept going as if nothing were wrong until a park's
`git reset --hard` reverted `TASKS.md` all the way back to its original
scaffold state (no intermediate commit had ever advanced the baseline) and
mismarked the *first* phase as blocked — not the phase that actually
parked. The script now uses a plain `git add -A` with no explicit pathspec
(which correctly skips a locally-ignored file with exit 0 regardless of
which mechanism ignores it) and stops outright with a clear error if a
commit ever fails after a green build, rather than silently continuing on
a false assumption.

A plain task's attempt that ends with `stoppedReason: "error"` gets a
`RETRY_BACKOFF_S`-second
pause (default 5) before the next attempt, since retrying a transient LM
Studio HTTP 500 or request timeout instantly tends to just hit the same
hiccup again — that same live run burned all 3 of one phase's attempts on
back-to-back HTTP 500s within 200ms, with the model never getting a real
turn. This backoff only covers the plain-task branch's own retry loop; a
`GOAL:` item's internal attempts are `kodr goal`'s own loop and aren't
backed off by this script.

A park also runs `git clean -fd` right after `git reset --hard`. The reset
only reverts *tracked* files — a stray new file a phase's abandoned attempt
created (a test file for an entity it never finished, say) survives
untracked, and `node --test` auto-discovers every test file regardless of
tracking, so that debris silently fails the *next* phase's verification for
a reason that has nothing to do with it. A live run hit exactly this: a
park left an untracked test file asserting against routes the reset had
just removed, which would have failed the following phase outright had it
gone uncaught. `git clean -fd` respects `.gitignore` (no `-x`), so it
doesn't touch `data/` or anything else already ignored — that's
`RESET_PATHS` below, a different job. This does mean the working tree is
assumed to be exclusively this script's during a run — don't hand-edit
files alongside it, the same way you already wouldn't with `git reset
--hard` in play.

`git reset --hard` only reverts *tracked* files. That same live run left three
separate parked phases' schema changes — `owner_id` columns, a `users` table,
`organization_id` columns — permanently baked into `data/crm.db`, with zero
trace in any committed source file, because the database is gitignored on
purpose and a park never touches it. `RESET_PATHS` (space-separated,
empty/unset by default) names gitignored paths to `rm -rf` alongside the
reset — e.g. `RESET_PATHS=data ./examples/phased-loop.sh`. Off by default:
it's destructive, and only the operator knows which paths are actually safe
to blow away and recreated on demand.

If a listed path was a directory, it's recreated empty right after the
wipe, not just left gone — a storage layer that opens a db file inside it
typically assumes the directory itself already exists and never `mkdir`s
it. Found live, on the very next run after adding `RESET_PATHS=data` to fix
the schema-drift bug above: a park correctly wiped `data/`, and every
phase after it failed with `unable to open database file` until the
directory was recreated by hand — "wipe the database" had silently turned
into "break everything from here on."

## Where this still falls short

Every `GOAL:` item in one checklist run starts from a blank slate — there is
no memory of *why* an earlier goal item stalled, only the workspace state it
left behind. Feeding a parked goal's final judge feedback into `MEMORY.md`
so the next phase (or the next run of this same checklist) starts already
knowing why it stalled is on the roadmap (see `specs/goal.yaml`'s `future`
section), not built yet. And this script itself is still the stand-in for a
real `kodr loop` subcommand that would take a `{ name, prompt, verify }`
queue natively instead of a hand-parsed Markdown checklist — also a `future`
item on the same spec, and the thing this script exists to prototype before
committing to that shape.
