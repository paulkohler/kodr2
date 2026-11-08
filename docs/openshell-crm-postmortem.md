# Post-mortem: the CRM phase plan in an OpenShell sandbox

Three attempts at running the fifteen-phase [CRM plan](../examples/crm/README.md)
unattended inside an [OpenShell sandbox](openshell-isolation.md), against a
local model, on 2026-11-07 and 2026-11-08. None finished. Each stopped for a
different reason, and each reason turned out to be worth knowing.

This is a record of what happened and what it taught us, not a how-to. The
operating advice that came out of it is in
[Long unattended runs](openshell-isolation.md#long-unattended-runs); the
harness bugs are in [`specs/BACKLOG.md`](../specs/BACKLOG.md).

## Summary

| | Run 1 (`crm-run`) | Run 2 (`crm2`) | Run 3 (`crm3`) |
|---|---|---|---|
| Result | parked at phase 2 | `mark-failed` at phase 3 | stopped by hand in phase 7 |
| Green phases | 1 | 2 | 5 |
| Parked phases | 1 | 0 | 1 (the first `GOAL:` phase) |
| Wall time | not recorded | 83 min | ~6 h 04 min |
| Cause of stopping | provider returned HTTP 500 on every attempt | the model ticked its own checklist line | my choice, after the run's limits had cost two hours |
| Fixed by | BACKLOG #10 | BACKLOG #12 | open, see [below](#what-did-not-work) |

Three things stand out.

1. **The model did not fail a test gate once in run 3.** Five `verify: pass`,
   zero `verify: fail`. Every attempt that was lost, twelve attempts for six
   phases and seven of them lost, was lost to the clock or the provider.
   The run measured our limits, not the model.
2. **The judge path has still never run in a sandbox.** Phase 6 is the first
   of the four `GOAL:` phases (the others are 8, 10 and 15). It parked before
   any build finished inside its budget, so `kodr goal`'s judge made no calls,
   and the other three were never reached.
3. **Two earlier fixes held under load.** BACKLOG #12 (the harness, not the
   workspace, tells the model the checklist is not its to edit) and #13
   (per-task progress on stdout) were both exercised for hours and did what
   they were built to do.

## Setup

Phases are numbered from 1 throughout this document, matching the loop's own
`task 4/15` output. (The working notes for runs 1 and 2 number from 0.)

The same baseline every time, so the runs are comparable: `examples/crm/`
copied into a fresh git repo, committed as `CRM phase plan` (`TASKS.md` with 15
unchecked items, four of them `GOAL:` lines; `AGENTS.md`; and
`.kodr/skills/sqlite-testing/`), with `data/ .kodr/ node_modules/` ignored.

- **Model:** `qwen3.8-27b-mlx` in LM Studio on the host, 262,144-token context
  loaded. Reached from the sandbox at `host.openshell.internal:1234`.
- **Sandbox:** OpenShell 0.1.7, a fresh named sandbox per run, held open by
  `KODR_SHELL_KEEPALIVE=172800` so it could not expire mid-run.
- **Run 3 launch** (detached, because a foreground shell is culled long before
  six hours):

```bash
nohup env \
  KODR_SHELL_SANDBOX=crm3 KODR_SHELL_WORKSPACE=/path/to/crm3 \
  KODR_SHELL_KEEP=1 KODR_SHELL_DOWNLOAD=1 KODR_SHELL_KEEPALIVE=172800 \
  scripts/kodr-shell.sh loop --test "npm test" --reset-paths data \
    --request-timeout-ms 1200000 --max-run-ms 1800000 --no-stop-on-park \
  > crm3.log 2>&1 < /dev/null & disown
```

`--no-stop-on-park` is the one flag that differs from a normal loop, and it was
deliberate: the point was to reach the `GOAL:` phases, which a park anywhere in
phases 1 to 5 would otherwise have made unreachable. The cost is described under
[Carrying on past a park](#carrying-on-past-a-park).

## Run 1: a provider outage looked like a model failure

Phase 1 went green. Phase 2 (Company and Contact CRUD) parked after the model
server returned `HTTP 500: Internal Server Error` on each of its attempts. The
loop spent its whole retry budget in seconds and then rewound the phase.

That became BACKLOG #10: an attempt that ends in a transient provider error is
now backed off and retried, and a run of them stops the loop with
`attempts-errored` rather than parking the phase as if the model had failed.

The same run also logged `line 258: syntax error near unexpected token 'do'`
from `kodr-shell.sh`, although `bash -n` passed on the file. The cause was
that bash reads a script incrementally from a file offset, and the script had
been edited in the repo while the run was in flight. The whole script body is
now a function called at the bottom, so it is parsed complete before any of it
runs; the explanation is in the script's own comments.

## Run 2: the model ticked its own box

Eighty-three minutes in, phases 1 and 2 were green (phase 2 failed its first
attempt and passed on the retry, which is the ratchet doing its job). Phase 3
(the Deal entity) finished **green and verified**, 68 tests passing twice, 30 of them new, and the
run then stopped without committing any of it:

```
checklist line 10 is no longer unchecked -- refusing to mark a different task
```

The model had already written `- [x]` to the line. In its own words:
"Marking the phase complete in `TASKS.md` (consistent with how prior phases
were recorded)". It had seen phases 1 and 2 recorded that way and copied the
convention, and nothing anywhere told it the checklist belonged to the loop.

The guard that refused is the BACKLOG #8 fix and was right to exist. What was
wrong was that it also fired on the one harmless case, the model writing the
very mark the loop was about to write, and that the price was a whole
unattended run. Two changes, both in BACKLOG #12:

- The mark is **idempotent**: a line already reading exactly
  `- [<mark>] <task text>` is success. A different mark, different text or a
  moved line still stops the run.
- The harness tells the model, in **its own system prompt** (the
  `<harness-checklist>` section, set by `kodr loop` and no other front end),
  that the checklist is not its to edit. An earlier plan put that sentence in
  the workspace's `AGENTS.md`; it belongs in Kodr, because otherwise every user
  has to remember to write it.

Run 2 also showed that `kodr loop` printed no per-task marker. Telling whether
"attempt 3" was the next phase or a retry meant shelling into the sandbox for
`git log`. That became #13.

## Run 3: five green, one parked, and a lot of lost time

Kodr `a81b323`, with #10, #11, #12 and #13 all in.

| Phase | Task | Attempts | Time | Result | Notes |
|---|---|---|---|---|---|
| 1 | Scaffold | 1 | 1,377 s | green `14ff3fd` | |
| 2 | Company and Contact CRUD | 2 | 2,878 s | green `37796e7` | attempt 1: request timeout |
| 3 | Deal entity | 1 | 1,225 s | green `e28db09` | |
| 4 | Deal state machine, audit log | 2 | 2,807 s | green `36b4323` | attempt 1: run budget |
| 5 | Note and Task entities | 2 | 2,962 s | green `aa7f1ea` | attempt 1: run budget |
| 6 | `GOAL:` ownership scoping | 4 | 7,572 s | **parked** `79564e1` | 3 run budgets, then a request timeout |
| 7 | filtering, sorting, pagination | 2+ | n/a | stopped by hand | attempt 1: request timeout |

Totals for phases 1 to 6, from the loop record: 6,087,646 prompt tokens and
206,382 completion tokens, 5 green, 1 parked. The record is written after each
task, so phase 7 is not in it.

### What worked

- **#12, both halves, on the case that killed run 2.** The model read
  `TASKS.md` four times, so it saw `- [x]` on the lines above, and wrote to it
  **zero** times. No `already ticked` notice ever fired. The prompt half did
  all the work, which means the idempotent-mark half is covered by unit tests
  only: a successful prompt makes the guard unreachable.
- **#13.** Every phase announced itself (`task 4/15 (task) ...`), every
  attempt was numbered, and every verdict carried its attempt count, duration
  and abbreviated sha. The first live run of the abbreviated sha was correct.
  `goal attempt 2/4` was visible too, which it could not have been before.
- **The transient-error path (#10) on a real provider.** A request timeout was
  classified as transient, backed off 5 s and retried as a new attempt, three
  times. It had only ever run against a stub.
- **The park, on its first live firing.** After phase 6 parked, the sandbox
  showed `HEAD` at `79564e1 kodr: park GOAL: ...` on top of phase 5's commit, a
  clean `git status`, the untracked `src/user.mjs` gone, `TASKS.md` marked
  `- [!]`, and `data/` present and **empty**: wiped by `--reset-paths` and
  recreated as a directory, which is the take-4 fix working as designed.
- **Attempts are cumulative.** A lost attempt cost wall-clock time, not work:
  the retry resumes the previous conversation with the files still on disk.
  Phases 2, 4 and 5 all recovered this way.
- **Stopping and downloading.** A SIGTERM to the kodr process inside the
  sandbox ended the loop, and the wrapper then ran its normal download, so the
  workspace came back with history intact.

### What did not work

#### The limits were misproportioned for this model

Run 3 used `--request-timeout-ms 1200000` (20 minutes) and
`--max-run-ms 1800000` (30 minutes), copied from run 2, which stopped too early
to stress them. They are a bad pair: a **single response can use two thirds of
an attempt's whole budget**, leaving ten minutes for every remaining tool turn.

The record of what that cost, across phases 1 to 7:

| Lost to | Count | Where |
|---|---|---|
| `Request timed out after 1200000ms` | 3 | phase 2, phase 6 attempt 4, phase 7 |
| `stopped after run budget` | 5 | phases 4 and 5, three times in phase 6 |

Seven of the twelve attempts in phases 1 to 6 were lost this way, so a phase that
needed one extra attempt in practice had none to spare, and from phase 4 onward
nearly every phase lost its first attempt to the clock. A response that does
land can land late: phase 2's second attempt completed a response at roughly
1,180 s of a 1,200 s ceiling, under half a minute from being discarded whole,
along with the three files it wrote.

The classification was right each time. A request timeout is transient and is
backed off; a budget stop is not and is retried at once, because there is
nothing to wait for. The problem was only the numbers.

#### It is generation, not the prompt

I suspected the prompt cache first, and that suspicion was wrong. Two numbers
had looked suspicious: kodr's usage showed 1.2 to 3.7 million prompt tokens
against 15 to 65 thousand completion tokens per phase (55:1 to 89:1), and one
request logged by LM Studio had only 8,960 of 30,865 prompt tokens cached.

LM Studio's own server log over the run 3 window says otherwise:

| | |
|---|---|
| Requests | 198 |
| Prompt-cache hit rate | **91.0%** |
| Uncached tokens per request | median 1,310; 90th percentile 5,316 |
| Cold requests (zero cached) | 9 |
| Requests with over 20,000 uncached | 4 |

So prompt processing is cheap and cache reuse is fine. The high ratio is
accounting: kodr's `usage.prompt` is the size of each request's whole prompt,
cached or not, so a thirty-turn attempt counts a growing conversation thirty
times. The 8,960-token request was one of the four outliers.

What is left is generation speed. 206,382 completion tokens over 18,823 s is
about **11 tokens per second wall-average**, which is a floor on real
generation speed because the average includes prompt processing and tool
execution. At that rate a 1,200 s response is at least roughly 13,000 tokens,
and one was watched in LM Studio's UI at about 21,000 tokens while still going.
A single response of that size is a model writing several large files in one
turn, possibly with reasoning on top. How much of it is reasoning is not
measured here.

I initially read that 21,000 as a prompt-token count, from a log entry for a
later request, and said so. It was output.

#### `kodr goal` treats a transient provider error as terminal

The plain-task branch classifies a request timeout as transient, backs off and
retries. The goal branch does not: `src/goal.mjs` maps `stoppedReason ===
'error'` straight to `goal stopped: build error` and returns.

```
note run failed: Request timed out after 1200000ms
tokens: 0 in / 0 out
note goal stopped: build error
note kodr loop: task 6/15 parked after 4 attempt(s), 7573s -- tree rewound
```

The same timeout that cost phase 2 one attempt and a five second sleep ended
phase 6 outright. #10's fix covered the plain-task loop only. In this instance
the outcome would very probably have been the same, since three of the four
goal attempts had already run out the clock, but on a healthier run one timeout
would be enough to kill a judged phase. Filed as BACKLOG #14.

#### Nothing bounds the length of a response

Kodr's request body is `{ model, messages, stream, stream_options, tools }`
and nothing else. There is no `max_tokens`, so the only thing that can stop a
long response is the wall-clock request timeout, and that fails in the
expensive direction: a token ceiling would end a response cleanly with its tool
calls intact, while a timeout discards whatever was in flight. Filed as #15.

#### A SIGTERMed loop leaves an unfinished record

Kodr handles `SIGINT` (see [`specs/cancel.yaml`](../specs/cancel.yaml)) but
has no `SIGTERM` handler. Stopping run 3 with `SIGTERM` worked, and the wrapper
downloaded the workspace, but the loop record ended with `"reason": null` and
without the task in flight. The graceful route is `SIGINT`. I did not try it
against a loop inside a sandbox. Filed as #16.

#### The judge path was never reached

Phase 6's four goal attempts produced no build that finished inside its
budget. Each of the first three ended `stopped after run budget`, and the log
shows no judge activity between a budget stop and the next attempt: a build the
clock cut off goes straight to the next attempt unjudged, which is the right
behaviour, since the judge should not spend an attempt on unfinished work.

Phase 6's last attempt left the retrofit nearly complete: all five entity
modules touched, a users table, a new 145-line auth module and 189 lines of
tests, with one failing assertion (`test/user.test.mjs:51`, an error message
that did not match). It was saved before the park and is recoverable.

#### Carrying on past a park

With `--no-stop-on-park`, phase 7 started on a foundation with no users table,
no `owner_id` and no authentication. Phases 8, 9, 13, 14 and 15 all say
"respects ownership scoping", "grouped by owner", "for that owner" or "scoped
to the user's organization", so each would have been asking for something that
did not exist. Their outcomes would have said very little about the model. The
run was stopped at phase 7 for that reason. Phases 7, 10, 11 and 12 do not
depend on auth and would have been a fair test.

## Mistakes in how the run was operated

Worth recording because the next operator will be tempted by the same things.

- **Copying a limit pair from a run that never stressed it.** `phased-loop.sh`'s
  own header warns that a large local model can outrun the request timeout well
  before the run budget is used up. I read the warning and then reused run 2's
  numbers.
- **Not acting at a clean boundary.** The right moment to re-proportion the
  limits was between phases 5 and 6. I proposed it and then let that boundary
  pass while waiting for a decision, and phase 6 is where the limits cost the
  most. A judged phase has a budget per attempt *and* a judge call, four
  attempts deep.
- **A monitor that could not see the events it was for.** `reporter.notice`
  output carries ANSI escapes, so `grep 'verify: pass'` finds nothing and
  `grep '^kodr loop:'` matches only the final summary. Separately, a filter
  containing the bare word `verify` matched the model's own streamed prose.
  Match on the exact notice text, and the escape-free part of it.
- **Reading a diagnosis off the wrong request.** See above.

## What was not exercised

Stated plainly so nobody assumes otherwise:

- **`kodr goal`'s judge** in a sandbox. Never reached.
- **The heal loop** in a sandbox.
- **`kodr tui`** in a sandbox. Not attempted, and not a gap in this work: it
  is an interactive terminal program and an unattended sandboxed run has
  nowhere to put one.
- **#10's 5xx path.** Request timeouts exercised the transient classification;
  an `HTTP 5xx` and the `attempts-errored` stop did not fire in run 3.
- **#11's end-of-run sweep.** The model never backgrounded anything, so no
  `killed N process` line appeared. Whether the sweep ran when the loop was
  killed was not checked.
- **#12's mark half**, for the reason above.
- **Phases 8 to 15** of the plan.

## Where the raw material is

The logs, run records and workspace copies are outside this repository, in the
testing tree beside it:

- `openshell/crm3.log`: the full stdout and stderr of run 3
- `openshell/crm3.returned/`: the final workspace, including
  `.kodr/loops/*.json` (the loop record) and `.kodr/runs/*.json` (one per
  attempt)
- `openshell/crm3.phase6-attempt4-start/`: the uncommitted phase 6 retrofit,
  copied out just before the park rewound it
- `openshell/CRM-RUN-NOTES.md`, `CRM-RUN-2-NOTES.md`, `CRM-RUN-3-NOTES.md`:
  the working notes this document was written from

A workspace copy can be taken from a sandbox that is still running with
`openshell sandbox download NAME /sandbox/<workspace> DEST`, which reads without
disturbing the run.
