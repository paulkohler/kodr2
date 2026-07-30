# Phase plan: a bigger CRM, driven by phased-loop.sh

A fifteen-phase build for [`phased-loop.sh`](../phased-loop.sh) — one phase at
a time, each either a plain `kodr run` task (hard-gated by `npm test`) or a
`GOAL: ` line (soft-gated by a read-only model judge, for the phases whose
"done" isn't something a test command can check).

Three files live here, and they have different jobs:

| File | What it is |
| --- | --- |
| [`TASKS.md`](./TASKS.md) | The checklist. Copied into the target repo as-is; this is all the loop reads. |
| [`AGENTS.md`](./AGENTS.md) | Workspace guidance — stack, SQLite patterns, API shape, style. Copied in too; Kodr reads it into every run's system prompt. |
| `README.md` | This file. Setup and rationale — **not** copied into the target repo. |

This expands on two prior runs of the same idea: `kodr2-no-deps-crm` (built
with `kodr run`/`kodr goal` directly) and a comparison repo that built the
identical 8-phase plan with Claude Code driving the same local model instead of
Kodr's own harness, to isolate the harness as the variable. Both stopped at
hardening. This plan carries the same CRM another six phases further — soft
delete, bulk import/export, webhooks, background jobs, and a second (bigger)
cross-cutting retrofit for multi-tenancy — so there's enough runway for "many
phases in one sitting" to actually mean something as a harness stress test, not
just a longer todo list.

Four of the fifteen phases are `GOAL: ` lines. That ratio is deliberate — most
of a real build is crisply testable, and the judge should only be in the loop
where a test command genuinely can't express "done."

## Run it

Set `KODR` and `CRM`, then paste the rest as-is. Every line matters; the notes
below say why.

```bash
KODR=/path/to/kodr2
CRM=/path/to/a/throwaway/crm

# 1. A git repo. The ratchet commits every green phase and reverts every
#    parked one, so git is the substrate, not an afterthought.
mkdir -p "$CRM" && cd "$CRM"
git init -q

# 2. The checklist and the workspace guidance. TASKS.md is what the loop
#    reads; AGENTS.md is what the model reads on every single run.
cp "$KODR/examples/crm/TASKS.md" .
cp "$KODR/examples/crm/AGENTS.md" .

# 3. Ignore the state that isn't source. data/ is the SQLite file phase 0
#    scaffolds; .kodr/ is Kodr's own run transcripts.
printf 'data/\n.kodr/\nnode_modules/\n' > .gitignore

# 4. COMMIT, before launching. A park runs `git reset --hard` + `git clean
#    -fd`; with nothing tracked, reset is a no-op and clean deletes every
#    untracked file — TASKS.md included. The script refuses to start without
#    a commit rather than let that happen, so this is not optional.
git add -A && git commit -qm "CRM phase plan"

# 5. Launch detached. Fifteen phases, four of them a judged multi-attempt
#    loop, is a multi-hour run; a foreground shell may be culled.
RESET_PATHS=data \
REQUEST_TIMEOUT_MS=1200000 \
RUN_MS=1800000 \
  nohup "$KODR/examples/phased-loop.sh" >phased-loop.out 2>&1 & disown
```

Watch it, and read the result:

```bash
tail -f phased-loop.out             # live progress
git log --oneline                   # one commit per green phase — the output
grep '^- \[!\]' TASKS.md            # phases that parked and need you
kodr stats                          # heal / retry / verify rates for the run
```

**Why each override:**

- `RESET_PATHS=data` — phase 0 scaffolds SQLite under `data/`, which is
  gitignored, and `git reset --hard` only reverts *tracked* files. Without
  this, a parked phase's schema changes survive its own revert and poison every
  later phase, invisibly. A live run of this exact plan hit that: three parked
  phases left permanent drift in `data/crm.db` with zero trace in any commit.
- `REQUEST_TIMEOUT_MS` / `RUN_MS` — a large local model under load can outrun
  the 10-minute default on a single request well before the run's own budget is
  spent. Raise both together for an overnight run.

To resume after a stop, fix or re-open any `- [!]` line in `TASKS.md` and
launch step 5 again — the loop picks up at the first unchecked item, because
every mark is committed.

## Editing the checklist

**One task per line.** The loop reads the checklist with `grep -m1 '^- \[ \] '`,
which returns a single line — so a task wrapped across two lines sends only its
first line to the model and silently drops the rest. Both scripts now refuse to
start on a wrapped item rather than truncate it, but it's worth knowing why the
lines in `TASKS.md` are so long.

Everything else about the file is free: headings, prose, and blank lines between
items are all ignored, since only `- [ ] ` lines are read.

## The phases

**0 — Scaffold.** Zero-dependency `node:http` server, a small hand-rolled
router, `node:sqlite` storage (or a documented JSON-file fallback), and one real
endpoint — `GET /health` — to prove the shape end-to-end.

**1 — Core entities.** `Company` and `Contact`, full CRUD, input validation with
clear 400s, tests per route including the validation-failure cases.

**2 — Relationships.** `Deal`, tied to a contact and a company. Also where the
delete-cascade behaviour gets decided and written down.

**3 — Business rules.** The stage-transition state machine, an audit log of
every stage change, and computed fields on deal read.

**4 — Activities & tasks.** `Note` and `Task`, both attachable to exactly one of
a contact or a deal. Additive only — this phase should touch no existing
endpoint (contrast with phase 5).

**5 — Auth retrofit** *(GOAL)*. Deliberately invasive: every endpoint from
phases 1–4 needs an owner check retrofitted onto it. The first of this plan's
"did the model actually touch everywhere it needed to" phases — a test suite can
assert individual routes are scoped, but "every existing endpoint, with no
regressions" is exactly the kind of totality claim a grounded judge is suited to
double-check by reading the routes itself, the way the
[review pass](../../specs/review.yaml) already does for a diff.

**6 — Search & pagination.** Filtering, sorting, and pagination on every list
endpoint. Cross-cutting like phase 5, but mechanically testable per endpoint —
so it stays a plain task.

**7 — Cross-entity search** *(GOAL)*. A single `/search-all` endpoint that has
to actually cover every entity, not just the easy ones. A prior run of this
exact feature shipped with deals silently missing from the results despite the
README and the tests both claiming full coverage — the test suite passed the
whole time. That's the textbook case for a grounded judge instead of trusting
"the tests are green" at face value.

**8 — Reporting.** Aggregate queries over the existing schema — pipeline value
by stage, conversion rate, and a leaderboard by owner. A good check that the
data model from phases 1–3 was sound enough to report on without restructuring.

**9 — Hardening** *(GOAL)*. Rate limiting, plus an audit of every route for a
consistent error shape and complete README coverage. "Every route" and "the
README documents every endpoint" are claims about the whole codebase, not a
single new behaviour.

**10 — Soft delete & restore.** Deletes stop being destructive. Mechanically
testable per entity, so this stays a plain task.

**11 — Bulk import/export.** CSV in, CSV out. The interesting part is what
happens to the bad rows, not the happy path.

**12 — Webhooks.** Outbound event notifications. New surface area, plain task.

**13 — Background jobs.** An in-process scheduler, no external queue or cron
dependency — this repo stays zero-dependency, so "background jobs" means a
`setInterval`-driven loop, not a new package.

**14 — Multi-tenant organizations** *(GOAL)*. The biggest retrofit in the plan:
every entity, every endpoint, every report, and the two background features all
need organization scoping layered on top of the owner scoping phase 5 added.
Same shape as phase 5, just bigger.

## Notes on running this

- **Phase 0 carries the whole run.** `TEST_CMD` defaults to `npm test`, and
  every later phase depends on it as the hard gate — so if phase 0 doesn't
  actually wire that script up, nothing after it can go green. It's the one
  phase worth watching live before walking away.
- **A parked phase is a checkpoint, not a failure.** `phased-loop.sh` reverts
  the partial work and marks the line `[!]`, then carries on to the next phase.
  Inspect `phased-loop.log` and the parked attempt's transcript in `.kodr/runs/`,
  then either fix the phase by hand or reword the checklist line and re-launch.
- **`GOAL_MAX_ATTEMPTS` (default 4) is per judged phase**, and those phases are
  the expensive ones: each attempt is a full build *plus* a read-only judge pass
  over the workspace.
- **Expect it to take hours**, and expect some phases to park. Fifteen phases
  against a local model is a harness stress test, not a delivery pipeline — the
  interesting output is as much `kodr stats` and the parked transcripts as it is
  the CRM itself.

For the general version of this workflow — any checklist, not just this one —
see [Drive a whole backlog unattended](../../docs/usage.md#13-drive-a-whole-backlog-unattended--the-loop-scripts)
in the usage guide.
