# Backlog

Known issues surfaced by a harness audit (2026-07-10) focused on the
Terminal-Bench-painful categories: timeouts, tool-loop limits, swallowed
errors, and context-window handling. Fix these spec-first like any other
change (write/adjust the spec, add a failing test, implement, `npm test`).

Line references are approximate — treat them as anchors, not addresses.

## Open

- **#15** nothing bounds the length of a model response except the wall
  clock. The request body `src/model.mjs` builds is `{ model, messages,
  stream, stream_options, tools }` — no `max_tokens` — so a long generation
  can only be ended by `--request-timeout-ms`, and that fails in the
  expensive direction: the response in flight is discarded whole, tool calls
  and all, where a token ceiling would end it cleanly with them intact. The
  third CRM run lost three attempts to the request timeout, and one response
  that did land had about 20 seconds to spare. Generation ran at roughly 11
  tokens per second wall-average on `qwen3.8-27b-mlx`, so 1200s is on the
  order of 13,000 tokens or more, and one was watched at about 21,000 while
  still running. It is also the shape `AGENTS.md` rules out, an operational
  limit the caller cannot set, except that here there is no limit to set. A
  ceiling needs to be configurable, off or generous by default, and the loop
  needs to decide what a truncated response means — a `finish_reason` of
  `length` is not an error and the model should be able to continue.

## Fixed

- **#16** SIGTERM now uses the graceful cancellation path for foreground
  run, goal, loop and consolidate commands. The loop saves reason
  `cancelled` and its interrupted task, preserves the workspace and unchecked
  checklist, and reaches the final orphan sweep. SIGINT and SIGTERM share a
  counter: the first cancels and the second forces exit (130 for SIGINT,
  143 for SIGTERM). Both retry loops now cancel their backoff timers too.
  Real subprocess tests cover both signals during commands and backoff for
  plain and GOAL tasks, including the saved record and a detached child's
  death. The original failure was a third CRM run stopped with `kill -TERM`
  inside OpenShell, leaving `reason: null` and omitting phase 7. Live
  OpenShell signal delivery has not been revalidated; the regression tests
  exercise local OS delivery and the shared cancellation/cleanup wiring.

- **#14** a transient provider error is terminal inside `kodr goal`. The
  plain-task branch of `kodr loop` classifies a request timeout as transient,
  backs off and retries (#10). `runGoal` does not: `src/goal.mjs` maps
  `stoppedReason === 'error'` straight to `goal stopped: build error` and
  returns, so one `Request timed out after 1200000ms` ends the whole judged
  item with attempts still unspent, and the loop parks it. Found in the third
  CRM dogfooding run (`docs/openshell-crm-postmortem.md`): phase 6's fourth
  goal attempt hit a request timeout, logged `tokens: 0 in / 0 out`, and the
  phase parked after 7573s. In that instance the outcome would very probably
  have been the same — attempts 1 to 3 had each run out the clock — but on a
  healthier run one timeout is enough to retire a judged phase, which is the
  most expensive kind. The fix is probably the same classification and
  back-off the plain branch already has, applied before `build-error` is
  returned, and it wants a spec change to `specs/goal.yaml` first. Whether a
  transient attempt should spend one of the goal's attempts, as it does for a
  plain task, is part of that call.

  Fixed: `runGoal` now notices a build error, waits `retryBackoffMs` and runs
  the next attempt unjudged while attempts remain; the errored attempt spends
  one, and only an error on the last attempt is `build-error`. Spec:
  `specs/goal.yaml`.

- **#13** `kodr loop` printed no per-task marker, so an unattended run was
  opaque while it mattered — three lines per task now reach the reporter's
  `notice` rather than only its byte-less `phase`: the task starting with its
  position in the checklist and its kind, each attempt numbered against the
  cap, and the verdict with its commit sha, attempt count and duration. A
  `GOAL: ` item announces its attempts too, since runGoal owns its own
  attempt loop and a judged item is the most expensive kind to be blind
  about. The position comes from the checklist's new optional `progress()`,
  so it is the place in the *file* (`task 7/15`) rather than the count
  attempted this invocation — optional the same way `git.headSha` is, so a
  collaborator without it degrades to the iteration count. Before this the
  only progress signal was the model's own `context window ...` notice at
  each attempt's start, which cannot tell the next phase from a retry of the
  current one; telling them apart during the second CRM dogfooding run meant
  shelling into the sandbox for `git log` and `TASKS.md`, three times
- **#12** the model marking the checklist itself halted the whole loop and
  left a green phase's work uncommitted — the mark is idempotent now: a line
  already reading exactly `- [<mark>] <task>`, the same mark on the same task
  text, is success rather than a refusal, because the write it was about to
  make is a no-op. A different mark, different text, or a moved line still
  stops the run, so #8's guard keeps its teeth; proving sameness needs the
  task text, so `checklistAdapter` now spends the text alongside the line
  index. The harness also tells the model the checklist is not its to edit,
  in its *own* system prompt (the new `checklistFile` option) rather than
  leaving it to each workspace's `AGENTS.md` — advisory, and belt and braces
  to the mark, not a substitute. A green task whose tick the model wrote
  itself now says so on stderr and on the loop record (`markedByAttempt`),
  because silence is how this stayed invisible until it cost a run. Found in
  the second CRM dogfooding run: `mark-failed` at phase 3 of 15 after 83
  minutes, with phase 2 green — verify pass, 68 tests green twice, 30 of them
  new — and none of it committed. In the model's own words from the log,
  "Everything checks out. Marking the phase complete in `TASKS.md` (consistent
  with how prior phases were recorded)": it had read the `- [x]` convention
  off phases 0 and 1 and copied it, the tidy thing to do, not the adversarial
  one. Same shape as #8 — a model-authored edit defeating a loop mechanism —
  by a different route. Still open as a design question, deliberately not
  taken: having the loop refuse the model's write to the tasks file outright
  while it drives that file, which would also block a task that legitimately
  needs to extend the checklist
- **#11** a cleanly-detached child outlived the run — `killTree` ran only
  from inside `runShell`, on output overflow, timeout and abort, so a command
  that *succeeds* having detached something was reaped by nothing. Every
  group the runner creates is now registered and dropped again at close once
  it is empty (one `kill(-pgid, 0)` syscall, not a `ps` fork), and the run
  sweeps whatever is left before it exits — SIGTERM, then SIGKILL after
  `--sweep-grace-ms` — reporting what it killed on stderr whether or not
  `--keep-orphans` spared it. Found live, and not by adversarial prompting:
  asked only to background a server and curl it, `qwen3.8-27b-mlx` hit the
  #9 timeout reaping, diagnosed it correctly ("the background job inherited
  the output pipe, so the command never finished"), and routed around it
  unprompted on its next tool call with
  `nohup node server.mjs > /dev/null 2>&1 &` — exit 0 in 7ms, no timeout to
  fire, server still answering after the run. The silence was the worse half
- **#10** a provider outage parked the task as though the model had failed
  it — a task whose *every* attempt ends stoppedReason "error" is no longer
  marked `[!]`: the tree is still rewound, the line is left `[ ]`, and the
  loop stops with reason `attempts-errored` so a rerun resumes the same task
  with nothing to hand-undo. Found in the CRM dogfooding run
  (`examples/crm/TASKS.md`): phase 1's three attempts were all HTTP 500 from
  a healthy LM Studio, ten seconds end to end, and the phase was retired
  permanently for it. A task that errors once and then fails its gate still
  parks — it got a fair attempt
- **#9** a backgrounded command's orphan survived the timeout — the runner
  now spawns into its own process group and signals the group (`execFile`
  silently drops `detached`, which is why the group never existed), with the
  ppid walk kept as a fallback and an AbortSignal plumbed through so Ctrl-C
  still reaches a detached command
- **#8** a model-authored `git commit` defeated the park path, mismarking
  the checklist — park now rewinds to the sha HEAD had before the attempt
  and the mark lands on the line index `readNextTask` returned, with a
  `mark-failed` stop when that line moved under the loop
- **#1** mid-loop failure zeroed run metrics — `8535040`
- **#2** near-deadline timeout mislabeled `error` vs `budget-exceeded` — `638e485`
- **#3** snapshot cap ignored below the workspace root — `2d4e318`
- **#4** non-SSE 200 swallowed as a successful empty completion — `66fb29c`
- **#5** compaction never fired when the provider omitted usage (Ollama) — `90cc232`
- **#6** sparse `tool_calls` (skipped stream index) crashed the loop — `424deb7`
- **#7** huge first user message defeated compaction (task now capped) — `9a44a75`

## Audited and found solid (no action)

Shell timeout / orphan-kill escalation, tool-recovery brace scanning, path
jail, the heal loop, and HTTP retry classification.
