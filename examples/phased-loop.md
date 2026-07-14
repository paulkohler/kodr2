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
```

Green items flip to `- [x]`, parked ones to `- [!]` — same convention as
`loop.sh`. `kodr stats` at the end shows heal/retry/verify/compaction rates
across the whole run, plain tasks and goals together.

For long runs, launch detached —
`nohup ./examples/phased-loop.sh >phased-loop.out 2>&1 & disown` — the same
advice `loop.sh` gives, more true here: a fifteen-phase plan with four
judged phases on top is a multi-hour run even on a fast local model.

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
