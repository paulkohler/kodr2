# Phase plan: a bigger CRM, driven by phased-loop.sh

A checklist for [`phased-loop.sh`](./phased-loop.sh) — one phase at a time,
each phase either a plain `kodr run` task (hard-gated by `npm test`) or a
`GOAL: ` line (soft-gated by a read-only model judge, for the phases whose
"done" isn't something a test command can check).

This expands on two prior runs of the same idea: `kodr2-no-deps-crm`
(built with `kodr run`/`kodr goal` directly) and a comparison repo that
built the identical 8-phase plan with Claude Code driving the same local
model instead of Kodr's own harness, to isolate the harness as the
variable. Both stopped at hardening. This plan carries the same CRM another
six phases further — soft delete, bulk import/export, webhooks, background
jobs, and a second (bigger) cross-cutting retrofit for multi-tenancy — so
there's enough runway for "many phases in one sitting" to actually mean
something as a harness stress test, not just a longer todo list.

Four of the fifteen phases below are `GOAL: ` lines. That ratio is
deliberate — most of a real build is crisply testable, and the judge should
only be in the loop where a test command genuinely can't express "done."

## Run it

Set `KODR=/path/to/kodr2` and `CRM=/path/to/a/throwaway/crm`, then paste the
rest as-is. Every line matters; the notes below say why.

```bash
KODR=/path/to/kodr2
CRM=/path/to/a/throwaway/crm

# 1. A git repo. The ratchet commits every green phase and reverts every
#    parked one, so git is the substrate, not an afterthought.
mkdir -p "$CRM" && cd "$CRM"
git init -q

# 2. The checklist, as TASKS.md — what phased-loop.sh reads and marks.
cp "$KODR/examples/crm-phases.md" TASKS.md

# 3. Ignore the state that isn't source. data/ is the SQLite file phase 0
#    scaffolds; .kodr/ is Kodr's own run transcripts.
printf 'data/\n.kodr/\nnode_modules/\n' > .gitignore

# 4. COMMIT, before launching. A park runs `git reset --hard` + `git clean
#    -fd`; with nothing tracked, reset is a no-op and clean deletes every
#    untracked file — TASKS.md included. The script now refuses to start
#    without a commit rather than let that happen, so this is not optional.
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
  this, a parked phase's schema changes survive its own revert and poison
  every later phase, invisibly. A live run of this exact plan hit that:
  three parked phases left permanent drift in `data/crm.db` with zero trace
  in any commit.
- `REQUEST_TIMEOUT_MS` / `RUN_MS` — a large local model under load can
  outrun the 10-minute default on a single request well before the run's own
  budget is spent. Raise both together for an overnight run.

To resume after a stop, fix or re-open any `- [!]` line in `TASKS.md` and
launch step 5 again — the loop picks up at the first unchecked item, because
every mark is committed.

---

## Phase 0 — Scaffold

Zero-dependency `node:http` server, a small hand-rolled router, `node:sqlite`
storage (or a documented JSON-file fallback if `node:sqlite` isn't
available), and one real endpoint — `GET /health` — to prove the shape
end-to-end.

- [ ] Scaffold a zero-dependency Node CRM API: package.json with no
      dependencies/devDependencies and an `npm test` script, a small
      hand-written node:http router (method + path matching, no framework),
      node:sqlite storage (fall back to a JSON file under data/ if
      node:sqlite isn't usable on this Node version, and say why in the
      storage module), and a GET /health endpoint returning { status: "ok"
      }. Wire node:test with one passing test for /health.

## Phase 1 — Core entities

`Company` and `Contact`, full CRUD, input validation with clear 400s, tests
per route including the validation-failure cases.

- [ ] Add Company (name, domain) and Contact (name, email, phone,
      company_id nullable) entities with full CRUD — POST/GET/GET
      :id/PUT :id/DELETE :id for both. Validate input with clear 400
      responses for missing required fields and malformed email; no
      unhandled throws should ever reach the client. Add tests per route,
      including the validation-failure cases.

## Phase 2 — Relationships

`Deal`, tied to a contact and a company. This is also where the
delete-cascade behavior gets decided and written down.

- [ ] Add a Deal entity (contact_id, company_id, value, stage enum: lead,
      qualified, proposal, won, lost; created_at) with full CRUD. Creating
      a deal validates the referenced contact and company exist. Decide and
      document (in a code comment at the top of the delete handler) whether
      deleting a contact or company with open deals blocks the delete or
      cascades — pick one and say why. Add tests covering the decision.

## Phase 3 — Business rules

The stage-transition state machine, an audit log of every stage change, and
computed fields on deal read.

- [ ] Add a stage-transition state machine to deals: only legal transitions
      are allowed (lead→qualified→proposal→won/lost; won and lost are
      terminal), an illegal transition returns 400 with a clear reason.
      Every stage change writes an Activity audit-log entry (deal id, from
      stage, to stage, timestamp). GET on a deal (and the deal list)
      includes computed fields days_in_current_stage and deal_age_days.
      Add tests for the legal/illegal transitions and the computed fields.

## Phase 4 — Activities & tasks

`Note` and `Task`, both attachable to exactly one of a contact or a deal.
Additive only — this phase should touch no existing endpoint (contrast with
phase 5).

- [ ] Add a Note entity (free text, attached to exactly one of contact_id
      or deal_id) and a Task entity (title, due_date, done boolean,
      attached to exactly one of contact_id or deal_id) with full CRUD.
      Add GET /tasks?overdue=true (undone tasks past due_date) and GET
      /tasks?upcoming=true (undone tasks due within the next 7 days,
      inclusive). This phase must not modify any existing route — only add
      new ones. Add tests per route and for the overdue/upcoming filters.

## Phase 5 — Auth retrofit

Deliberately invasive: every endpoint from phases 1–4 needs an owner check
retrofitted onto it. This is the first of this plan's "did the model
actually touch everywhere it needed to" phases — a test suite can assert
individual routes are scoped, but "every existing endpoint, with no
regressions" is exactly the kind of totality claim a grounded judge is
suited to double-check by reading the routes itself, the way the
[review pass](../specs/review.yaml) already does for a diff.

- [ ] GOAL: every existing endpoint (companies, contacts, deals, notes,
      tasks) has been retrofitted with ownership scoping — hand-rolled API
      key auth (a users table, hashed key lookup, one admin bootstrap
      path), every record gains an owner_id, a regular user only
      sees/modifies records they own (404, never 403, for someone else's
      record), an admin role sees and modifies everything, and there is
      test coverage proving the scoping on every entity, not just a
      sample. Document the auth flow in the README.

## Phase 6 — Search & pagination

Filtering, sorting, and pagination on every list endpoint. Cross-cutting
like phase 5, but mechanically testable per endpoint (pass specific query
params, assert the filtered/sorted/paged result) — so it stays a plain
task rather than a GOAL: line.

- [ ] Add filtering (e.g. GET /deals?stage=proposal&company_id=X, GET
      /contacts?company_id=X), sorting (?sort=field&order=asc|desc), and
      pagination (?limit=&offset=; document the choice) to every list
      endpoint across companies, contacts, deals, notes, and tasks. Guard
      against SQL injection via the sort field (validate against an
      allow-list, don't string-concatenate it into the query). Add tests
      per entity for filtering, sorting, and pagination, including an
      invalid sort field returning 400 rather than a raw SQL error.

## Phase 7 — Cross-entity search

The route this plan is named after, in a sense: a single `/search-all`
endpoint that has to actually cover every entity, not just the easy ones. A
prior run of this exact feature shipped with deals silently missing from
the results despite the README and the tests both claiming full coverage —
the test suite passed the whole time. That's the textbook case for a
grounded judge instead of trusting "the tests are green" at face value.

- [ ] GOAL: the /search-all route is documented in the README and has a
      comprehensive test suite; it searches every core entity — companies,
      contacts, deals, notes, and tasks — for a substring match against
      their relevant text fields (deals have no free-text field of their
      own, so match against their linked contact/company name, or document
      explicitly why deals are excluded if that's the design choice made),
      respects ownership scoping the same way the list endpoints do, and
      returns results grouped by entity type.

## Phase 8 — Reporting

Aggregate queries over the existing schema — pipeline value by stage,
conversion rate, and a leaderboard by owner. A good check that the data
model from phases 1–3 was sound enough to report on without restructuring.

- [ ] Add GET /reports/pipeline (total deal value grouped by stage, all
      five stages always present even at 0), GET /reports/conversion (lead
      → won conversion rate, optional from/to date range query params), and
      GET /reports/leaderboard (deals won and total won value grouped by
      owner, sorted by deals won then value descending; a regular user
      sees only their own row, an admin sees every owner's row). Add tests
      for each report, including the ownership-scoping difference on the
      leaderboard.

## Phase 9 — Hardening

Rate limiting, plus an audit of every route for a consistent error shape
and complete README coverage. The second of this plan's completeness
phases — "every route" and "the README documents every endpoint" are
claims about the whole codebase, not a single new behavior, and (per the
phase 5 rationale above) that's what the judge is for.

- [ ] GOAL: the API has basic rate limiting (an in-memory token bucket per
      API key or IP, limits configurable via env vars rather than hardcoded,
      429 with a Retry-After header when exceeded), every route across the
      whole API returns a consistent error response shape ({ error:
      "message" }) with no route left using an ad hoc shape, and the
      README documents every endpoint that exists in the codebase — method,
      path, request body shape, and an example response — with no
      endpoint present in the code but missing from the docs (or vice
      versa).

## Phase 10 — Soft delete & restore

Deletes stop being destructive. Mechanically testable per entity, so this
stays a plain task.

- [ ] Change DELETE across all entities (companies, contacts, deals,
      notes, tasks) to a soft delete: set a deleted_at timestamp instead of
      removing the row. All GET/list endpoints exclude soft-deleted records
      by default; add a query param (e.g. ?includeDeleted=true) to include
      them. Add a POST /:entity/:id/restore endpoint that clears
      deleted_at. Update the existing cascade behavior from phase 2 to
      cascade the soft delete instead of a hard delete. Add tests for the
      default-excluded behavior, includeDeleted, and restore.

## Phase 11 — Bulk import/export

CSV in, CSV out. The interesting part is what happens to the bad rows, not
the happy path — testable with a handful of well-chosen fixture files, so
this stays plain rather than GOAL:.

- [ ] Add POST /contacts/import and POST /companies/import accepting a CSV
      body: valid rows are created, and a row with a missing required
      field or malformed email is skipped and reported by row number in
      the response rather than silently dropped or aborting the whole
      import. Add GET /contacts/export and GET /companies/export returning
      CSV of the (non-deleted) records. Add tests for a mixed valid/invalid
      CSV import and for export round-tripping back through import.

## Phase 12 — Webhooks

Outbound event notifications. New surface area, plain task.

- [ ] Add a webhook subscription mechanism: POST /webhooks registers a
      target URL and an event type (start with deal.stage_changed). When a
      deal's stage changes, POST the event payload (deal id, from stage, to
      stage, timestamp) to every subscribed URL for that owner. Retry a
      failed delivery up to 3 times with backoff before giving up and
      recording the failure. Add tests using a local mock HTTP receiver —
      no external service — covering a successful delivery, a failing
      receiver retried and eventually given up on, and that only the
      subscribing owner's webhooks fire for their own deals.

## Phase 13 — Background jobs

An in-process scheduler, no external queue or cron dependency — this repo
stays zero-dependency, so "background jobs" means a `setInterval`-driven
loop, not a new package.

- [ ] Add an in-process scheduled job (no external cron/queue package) that
      runs periodically (configurable interval, sensible default) and
      compiles a per-owner digest of overdue and upcoming (due within 7
      days) tasks, then delivers it through the phase 12 webhook mechanism
      as a new event type (tasks.digest). Make the job's own interval and
      the digest window configurable via env vars, not hardcoded. Add
      tests that trigger the job function directly (not by waiting on a
      real timer) and assert the digest content and delivery.

## Phase 14 — Multi-tenant organizations

The biggest retrofit in the plan: every entity, every endpoint, every
report, and the two background features (webhooks, digests) all need
organization scoping layered on top of the owner scoping phase 5 already
added. Same shape as phase 5, just bigger — same reason it's a GOAL: line.

- [ ] GOAL: the API supports multiple organizations — every entity
      (companies, contacts, deals, notes, tasks) and every derived feature
      (search-all, reports, webhooks, the background digest job) is scoped
      to the requesting user's organization in addition to their existing
      owner scoping, a user can never see or modify another organization's
      data regardless of role, an admin's "sees everything" from phase 5
      now means everything within their own organization only, and there
      is test coverage proving cross-organization isolation on every
      entity and every derived feature, not just a sample.

---

## Notes on running this

- **Phase 0 carries the whole run.** `TEST_CMD` defaults to `npm test`, and
  every later phase depends on it as the hard gate — so if phase 0 doesn't
  actually wire that script up, nothing after it can go green. It's the one
  phase worth watching live before walking away.
- **A parked phase is a checkpoint, not a failure.** `phased-loop.sh` reverts
  the partial work and marks the line `[!]`, then carries on to the next
  phase. Inspect `phased-loop.log` and the parked attempt's transcript in
  `.kodr/runs/`, then either fix the phase by hand or reword the checklist
  line and re-launch — the loop resumes at the first unchecked item.
- **`GOAL_MAX_ATTEMPTS` (default 4) is per judged phase**, and those phases
  are the expensive ones: each attempt is a full build *plus* a read-only
  judge pass over the workspace.
- **Expect it to take hours**, and expect some phases to park. Fifteen phases
  against a local model is a harness stress test, not a delivery pipeline —
  the interesting output is as much `kodr stats` and the parked transcripts
  as it is the CRM itself.

For the general version of this workflow — any checklist, not just this one —
see [Drive a whole backlog unattended](../docs/usage.md#13-drive-a-whole-backlog-unattended--the-loop-scripts)
in the usage guide.
