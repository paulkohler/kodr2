# `kodr loop` — drive a checklist unattended

Kodr is a one-shot harness: one `kodr run` is one task. `kodr loop` is the
*outer loop* — hand it a `TASKS.md` checklist and it works down the list for
hours, committing each task that goes green and parking the ones it can't
finish, until the backlog is empty, a park stops it, or a budget is hit. This
is the core way to get a night's worth of work out of Kodr rather than one
task at a time.

Status: implemented — [`specs/loop.yaml`](../specs/loop.yaml),
[`src/loop.mjs`](../src/loop.mjs), [`src/loop-git.mjs`](../src/loop-git.mjs),
[`src/loop-record.mjs`](../src/loop-record.mjs), launched by `kodr loop`. It
promotes the same ratchet [`examples/loop.sh`](../examples/loop.sh) and
[`examples/phased-loop.sh`](../examples/phased-loop.sh) already implement in
bash into a first-class subcommand — see [§ vs. the bash scripts](#kodr-loop-vs-the-bash-scripts)
for when to reach for which.

## Quick start

```bash
cd /path/to/your/project
```

```markdown
<!-- TASKS.md -->
- [ ] Add Company (name, domain) and Contact (name, email, company_id) with
      full CRUD. Validate input with clear 400s for missing fields and
      malformed email. Add tests per route.
- [ ] GOAL: every endpoint has an owner check and the README documents all of them
```

```bash
git add -A && git commit -m "checklist"   # the loop needs a baseline to reset to
nohup kodr loop --test "npm test" >loop.out 2>&1 & disown
```

Commit the checklist first — a park runs `git reset --hard` + `git clean -fd`,
and with nothing tracked yet that deletes every untracked file, the checklist
included. `kodr loop` refuses to start rather than let that happen (see
[Gotchas](#gotchas)). Launch detached: a real backlog runs for hours, and a
foreground shell may be culled.

Come back and read `git log` — that's the deliverable.

## The ratchet

Each checklist line is one iteration, and only one outcome commits:

- **Green** — the run *completed*, actually changed files, and didn't fail
  `--test`. The task's code and its `- [x]` tick land in the **same commit**
  (mark-then-commit order), so a later task's park can never silently un-tick
  it.
- **Red** — retries in place with the prior transcript replayed, up to
  `--max-attempts`. The broken code stays on disk for the model to see what it
  just tried. An attempt that ends in a transient error (an HTTP 500, a
  timeout) backs off first — `--retry-backoff-ms`; a genuine build/test
  failure gets no delay.
- **Gives up (parks)** — `git reset --hard` then `git clean -fd` puts the tree
  back to the last green commit, any configured `--reset-paths` are wiped on
  top, and the task is marked `- [!]` in its own commit so it isn't picked
  again. By default the whole loop then **stops**: a checklist is ordered, so
  anything after a parked task would build on a foundation that was just
  reverted. Pass `--no-stop-on-park` to carry on instead, when the backlog is
  independent tasks rather than an ordered plan.

A `GOAL: ` line is judged instead of gated by `--test`: it routes to
`kodr goal`'s own build+judge loop (`--goal-max-attempts` attempts, default
one more than a plain task), and its green decision is *met* **and**
*something actually changed* **and** verification didn't fail. See
[`specs/goal.yaml`](../specs/goal.yaml) for the judge's own contract. Use
`GOAL: ` only where a test command genuinely can't express "done" — "every
endpoint has an owner check," "the README documents all of it." Most of a
real build is crisply testable; keep the judge for the rest.

Every git operation is a returned value, never a throw — a failed commit
stops the loop with reason `commit-failed` rather than continuing on a false
assumption that it worked.

## Flags

All of the ordinary run options work here too and are passed through per task
(`--provider`, `--model`, `--test`, `--cwd`, `--context-window`,
`--max-tool-turns`, `--max-run-ms`, `--memory`, …). Loop-specific:

| Flag                                  | Env var                       | Default    | What it does                                                             |
| -------------------------------------- | ------------------------------ | ---------- | -------------------------------------------------------------------------- |
| `--tasks <file>`                       | `KODR_LOOP_TASKS_FILE`         | `TASKS.md` | The checklist                                                             |
| `--max-attempts <n>`                   | `KODR_LOOP_MAX_ATTEMPTS`       | `3`        | Retries per plain task before parking                                    |
| `--goal-max-attempts <n>`              | `KODR_LOOP_GOAL_MAX_ATTEMPTS`  | `4`        | `kodr goal`'s own attempts per `GOAL: ` line                              |
| `--retry-backoff-ms <n>`               | `KODR_LOOP_RETRY_BACKOFF_MS`   | `5000`     | Pause before retrying a *transient*-error attempt (`0` disables)         |
| `--reset-paths <path>` (repeatable)    | `KODR_LOOP_RESET_PATHS`        | _(empty)_  | Gitignored paths to wipe on park, alongside the reset — see below         |
| `--stop-on-park` / `--no-stop-on-park` | `KODR_LOOP_STOP_ON_PARK`       | stop       | Stop the whole loop when a task parks, or carry on to the next one       |
| `--max-loop-ms <n>`                    | `KODR_LOOP_MAX_MS`             | `0` (off)  | Wall-clock ceiling for the whole loop, checked between tasks              |
| `--max-loop-cost <n>`                  | `KODR_LOOP_MAX_COST`           | `0` (off)  | Cumulative cost ceiling across the loop, checked between tasks            |
| `--max-tasks <n>`                      | `KODR_LOOP_MAX_TASKS`          | `0` (off)  | Stop after this many tasks — the cheap way to smoke-test a long checklist |

`KODR_LOOP_RESET_PATHS` is space-separated, matching
[`examples/loop.sh`](../examples/loop.sh)'s own `RESET_PATHS` convention.

```bash
kodr loop --tasks TASKS.md --test "node --test" \
  --max-attempts 5 --reset-paths data --no-stop-on-park

# budget-cap an overnight run
kodr loop --test "npm test" --max-loop-ms 28800000   # 8 hours
```

## Writing a checklist that finishes

Same advice as the bash scripts, because it's the same ratchet underneath:

- **One task per line.** `readNextTask` reads the first unchecked `- [ ] `
  line and nothing else.
- **One task ≈ one commit's worth of work.** "Build the app" parks; "add the
  Company CRUD routes with validation tests" goes green.
- **Name the files and the acceptance criteria in the task.** The tasks that
  succeed first-try read like a small PR description.
- **`--test` is the gate, so every task must be able to pass it.** A task
  whose success would break an existing test will burn every attempt and park.
- **Order matters.** Each task starts from the previous one's commit, so put
  scaffolding first.

## Reading the results

```bash
git log --oneline          # one commit per green task — the actual output
grep '^- \[!\]' TASKS.md   # what parked, and needs you
kodr stats                 # heal / retry / verify rates across the whole run
```

`kodr loop` also writes a **loop record** to `.kodr/loops/<timestamp>.json`,
rewritten after every task transition — not just at the end, so a loop that's
`SIGKILL`ed or whose host dies still leaves everything up to its last
transition on disk. One entry per task: the task text, its kind, outcome,
attempts, `stoppedReason`/`goalReason`, files changed, the commit it produced,
usage, and duration. This is what `git log` alone can't give you: a loop
whose logs went quiet still has a record you can read to tell "healthy and
slow" from "actually stuck," and the loop-level summary (`{ reason, green,
parked, usage, durationMs, recordPath }`) agrees with it field for field.

Parked tasks are the interesting ones: their run transcripts are in
`.kodr/runs/`, and `kodr replay last` re-runs one from scratch to see whether
it reproduces.

## Gotchas

- **`--test` is the only thing that can catch broken output.** Green means
  *completed + files changed + verification didn't fail* — with no `--test`
  configured, a model that writes syntactically broken code still goes green,
  because there's nothing to check it against. Verified live: a checklist run
  against a 70B model with no `--test` produced a file whose model-generated
  content had literally double-escaped `\n` sequences (valid JSON, broken
  JS) — the harness wrote exactly what it was told, and the ratchet had no
  way to know. This isn't a bug to fix; it's the reason `--test` exists.
- **A no-op "complete" still parks.** A model can call no tools at all, or
  reply as if it finished without touching a file — some providers'
  tool-calling is unreliable enough that this happens (seen live: a model
  emitting its tool call as inline text instead of using the provider's
  structured tool-call field). `noOpCompletion` catches this — *completed*
  alone isn't green, files must have actually changed — so a plausible-sounding
  non-answer retries and eventually parks instead of silently "succeeding."
- **`--reset-paths` only wipes gitignored/untracked paths, never tracked
  ones.** A park's mark commit runs `git add -A` right after, so wiping
  something git tracks would stage and permanently commit that loss —
  refused instead. Also refuses `.` , `..`, `.git` (any spelling that
  resolves to it), and any absolute path, even one that happens to sit inside
  the workspace.
- **The loop refuses to start if the checklist itself isn't committed.** Not
  just "the repo has a commit somewhere" — the checklist file specifically
  has to be tracked, or the very first park's `git clean -fd` deletes it
  outright, taking the plan with it.
- **`.kodr/` is excluded from git automatically**, so a green task's commit
  never sweeps in a run transcript as noise, and a parked task's transcript
  survives the park's `git clean -fd` instead of being deleted with the rest
  of the untracked debris. If you redirect your own log file into the
  workspace (`nohup kodr loop >loop.out 2>&1 &`), that file is *not* excluded
  automatically — a park's `git clean -fd` deletes it same as any other
  untracked file. Redirect outside the repo, or add it to
  `.git/info/exclude` yourself, the way the bash scripts do for their own
  `loop.out`/`loop.log`.
- **Ctrl-C stops cleanly, it doesn't park.** A cancelled attempt (`stoppedReason:
  "cancelled"`) is not treated as a build failure — the loop stops immediately
  with reason `cancelled` and touches nothing: no mark, no commit, no
  `git reset --hard` over whatever you just interrupted.

## `kodr loop` vs. the bash scripts

| |`kodr loop`|`examples/loop.sh` / `phased-loop.sh`|
|---|---|---|
| Dependencies | none beyond Kodr itself | `jq`, bash ≥ 4.4 |
| GOAL: lines | always supported, one entry point | only `phased-loop.sh` |
| Progress record | `.kodr/loops/<timestamp>.json`, live | `loop.out`/`loop.log` text, and only what you redirect |
| Aggregate budget | `--max-loop-ms` / `--max-loop-cost` / `--max-tasks` | none — only per-attempt limits |
| Editable | it's the harness itself | it's a script you can read and hand-edit |

Reach for the bash scripts when you want something you can open and change
without touching Kodr's own source, or when driving Kodr from a shell that
doesn't have it installed is the point. Otherwise `kodr loop` is the more
capable default — same contract
([`specs/loop-scripts.yaml`](../specs/loop-scripts.yaml) is adopted wholesale
by [`specs/loop.yaml`](../specs/loop.yaml)), fewer moving parts.

## References

- Contract and full test list: [`specs/loop.yaml`](../specs/loop.yaml)
- The judge for `GOAL: ` lines: [`specs/goal.yaml`](../specs/goal.yaml)
- The bash equivalent, with more live-failure war stories:
  [`examples/loop.md`](../examples/loop.md),
  [`examples/phased-loop.md`](../examples/phased-loop.md)
- A worked 15-phase plan mixing plain tasks and `GOAL: ` lines:
  [`examples/crm/`](../examples/crm/)
