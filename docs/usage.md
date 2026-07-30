# Using Kodr

Kodr is a one-shot coding harness: you give it a prompt, it assembles
workspace context, lets a local or hosted model read and write files with
tools, optionally verifies the result, and heals if verification fails.

This page is the practical guide — the most common options first, then the
rest in roughly descending order of how often you reach for them. For the
"what it is / why it exists" overview see the [README](../README.md); for the
exact contracts see the specs in [`specs/`](../specs/).

There are three ways to drive Kodr:

- **One-shot runs** (`kodr "…"`) — fire a task, watch it stream, get the
  result. Scripts and pipelines use this.
- **The interactive TUI** (`kodr tui`) — a full-screen, multi-turn REPL that
  keeps the conversation going across follow-ups. This is the nicest way to
  work by hand, and it's covered in [§3](#3-the-terminal-ui-interactive).
- **Unattended over a backlog** (`./examples/loop.sh`) — hand it a `TASKS.md`
  checklist and it works down the list for hours, committing each task that
  passes and parking the ones it can't finish. This is how you get a night's
  work out of it; see
  [§13](#13-drive-a-whole-backlog-unattended--the-loop-scripts).

Everything below assumes `kodr` is on your `PATH` (see the README's
[Quick start](../README.md#quick-start)). From a checkout you can always
substitute `node bin/kodr.mjs` for `kodr`.

---

## 1. The one-shot run — the common case

```bash
kodr run "add input validation to server.mjs"

# `run` is the default, so this is identical:
kodr "add input validation to server.mjs"
```

Kodr reads your workspace instructions (`KODR.md` or `AGENTS.md`), builds a
file listing, streams the model's response, and executes the tools it calls
(`read_file`, `write_file`, `edit_file`, `list_files`, `search`,
`run_command`). Out of the box it talks to **LM Studio** on
`http://localhost:1234` — load a tool-capable model there and you need no
further setup.

Useful right away:

```bash
kodr "fix the failing test" --quiet     # -q: suppress the live token stream
kodr "…" --cwd path/to/project          # run against another directory
```

## 2. Pick your model and provider

The default provider is LM Studio and it **auto-detects** the loaded model,
so most local runs need no `--model` at all. To be explicit, or to use a
hosted backend:

```bash
# See what LM Studio has, and how much context each model is actually loaded with
kodr models

# Name a model explicitly
kodr "…" --model google/gemma-4-26b-a4b

# OpenRouter — hosted, needs a key, and --model is required
export OPENROUTER_API_KEY=sk-or-...
kodr "…" --provider openrouter --model qwen/qwen3.6-35b-a3b

# Ollama — local by default; add a ":cloud" model or point --base-url at
# ollama.com for hosted access
kodr "…" --provider ollama --model qwen3-coder:30b
```

Set them once for a shell or a script instead of repeating flags:

```bash
export KODR_PROVIDER=openrouter
export KODR_MODEL=qwen/qwen3.6-35b-a3b
kodr "…"        # picks both up
```

`--model`/`--provider` win over `KODR_MODEL`/`KODR_PROVIDER`. See the
README's [Providers](../README.md#providers) table for what differs between
the three (auth, context-window auto-detect, cost reporting, `--reasoning`
support).

Not sure the environment is ready? `kodr doctor` checks the resolved
provider's reachability, a usable model, git, and the Node.js version before
a run fails mid-task:

```bash
kodr doctor
```

## 3. The terminal UI (interactive)

For working by hand, launch the full-screen REPL instead of firing one-shot
commands:

```bash
kodr tui                      # empty; type your first prompt into the box
kodr tui "start on the parser" # seed the first turn
kodr --tui                    # identical to `kodr tui`
```

It needs a real interactive terminal (it can't be combined with `--json`,
`--quiet`, or `--events`). What you get:

- **A live run per turn.** Each prompt is a full `run()` — streamed into the
  scrollback with a status header showing model, phase, tokens, cost, and
  elapsed time.
- **Multi-turn by default.** A follow-up continues the _same_ conversation
  (the same mechanism as `--continue` below) — no need to restate context.
- **One run at a time.** Type a follow-up while a run is active and it's
  _queued_ (a single slot, shown in the header); it starts automatically when
  the current turn finishes.
- **Markdown rendering.** Assistant text is rendered inline — bold, italic,
  `code`, bullets, and headings.
- **Optional command approval.** Add `--approve-commands` and the TUI asks
  for `y/N` before each `run_command`; deny one and the model gets an error
  result instead of the command running.

```bash
kodr tui --approve-commands --test "npm test" --model google/gemma-4-26b-a4b
```

Every run option works here too (`--provider`, `--model`, `--test`, `--cwd`,
`--context-window`, …). **Ctrl-C** doesn't quit on the first press — as
insurance, it asks you to press it again (`press ctrl-c again to quit`). While a
run is active the first press interrupts it (like `/stop`); a second press
within a few seconds quits, so it's still an escape hatch mid-run. Any other key
stands the quit down. Either way the terminal is restored cleanly on exit.

### Slash commands

Type a `/`-prefixed word at the start of the input to run a meta-command —
`/help`, `/clear`, `/model`, `/diff`, `/stop`, and more — instead of sending a
prompt to the model. As you type, the hint row at the bottom turns into a live
autocomplete: hit `/` and it lists the matching commands, narrowing with each
keystroke, and **Tab** completes the one you're typing (to the full command when
only one matches, otherwise to the longest shared prefix). `/help` lists them
all; an unrecognized `/word` is passed to the model as a normal prompt rather
than swallowed. See [§11](#11-slash-commands-for-the-tui) for the full table.

## 4. Verify your changes — `--test`

Give Kodr a command to prove its work. If files changed, Kodr runs it; if it
fails, the failure is fed back to the model for up to three **heal** turns.

```bash
kodr "refactor the auth module" --test "npm test"
kodr "port the parser to the new API" --test "node --test" --heal-turns 5
```

`--test` registers as the first Stop hook (see
[`specs/hooks.yaml`](../specs/hooks.yaml) for the full hook model). A clean
verify is how a run earns "done."

## 5. Continue a previous run — `--continue`

Extend the last conversation with a new instruction, instead of starting
cold:

```bash
kodr "scaffold an Express TODO API"
kodr "now add input validation" --continue last
kodr "add pagination to the list endpoint" --continue last
```

`last` resolves to the most recent saved run; you can also pass an explicit
transcript path. (This is exactly what the TUI does between turns.) For a
worked multi-turn walkthrough see
[`examples/todo-express.md`](../examples/todo-express.md).

## 6. Keep long sessions alive — context window & `/compact`

Long runs stay inside the model's context window through **compaction**: once
the live prompt crosses 80% of the window, the older history is summarized
into one dense message. Kodr auto-detects the window where the provider
reports one (LM Studio, OpenRouter) and otherwise falls back to a
conservative default (Ollama). Override it when you know better:

```bash
kodr "…" --context-window 262144      # or KODR_CONTEXT_WINDOW
kodr "…" --context-window 0           # disable compaction entirely
```

You can also compact on demand rather than waiting for the threshold:

```bash
kodr "/compact" --continue last       # from the CLI
# …or just type `/compact` in the TUI.
```

## 7. Command sandbox & approvals — `--env`, `--approve-commands`

`run_command` and the `--test` command run with a **minimal, curated
environment** — only a small allowlist (`PATH`, `HOME`, `TMPDIR`, locale
vars) is passed through, so model-suggested commands can't read secrets from
your shell. Forward specific variables by name when a command needs them:

```bash
kodr "run the integration suite" --test "npm run test:int" --env API_BASE_URL,CI
```

Only named variables that actually exist are forwarded, and their values are
never shown to the model. In the TUI, add `--approve-commands` to gate every
`run_command` behind a `y/N` prompt.

## 8. Reasoning models — `--reasoning`

Ask the provider for reasoning tokens on every call. Only **OpenRouter**
supports this today; Kodr errors at startup if the resolved provider doesn't,
rather than silently dropping it.

```bash
kodr "…" --provider openrouter --model … --reasoning
```

## 9. Let Kodr learn — `--memory`

At the end of a run, propose durable lessons for future runs in this
workspace. Kodr never writes to `MEMORY.md` without a human decision — an
attended terminal gets a `y/N` prompt; otherwise a proposal file is written
next to the transcript.

```bash
kodr "…" --memory
kodr "…" --memory --memory-auto-apply   # trust the loop; skip the prompt
```

## 10. A second pair of eyes — `--review-model`

After a successful build, run a review pass on a _different_ model. Kodr owns
the LM Studio load/unload/verify sequencing for both models via the `lms`
CLI, so you can build on a fast model and review on a stronger one.

```bash
kodr "…" --review-model qwen/qwen3.6-35b-a3b
```

Related tuning: `--review-context-window`, `--review-min-tool-calls`,
`--review-max-tool-turns` (see [`specs/review.yaml`](../specs/review.yaml)).

## 11. Slash commands for the TUI

Slash commands are TUI meta-commands: they act on the _session_ — the
conversation, the config, the view — rather than being sent to the model as a
prompt. Type a `/`-prefixed word at the start of the input. An unrecognized
`/word` is **not** swallowed — it's sent to the model as an ordinary prompt —
so `/help` is the safe way to see what's actually recognized.

Most commands work mid-run (they act on the session, not the model). A few
that would corrupt an in-flight turn — `/compact`, `/clear`, `/retry`,
`/model`, `/test` — are declined with a notice while a run is active.

| Command                 | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `/help`, `/?`           | List the available slash commands and their descriptions       |
| `/compact`              | Compress the conversation into a summary and continue          |
| `/clear`, `/new`        | Start a fresh conversation, dropping the prior history         |
| `/retry`                | Re-run the last prompt fresh, discarding that turn's result    |
| `/stop`, `/cancel`      | Abort the in-flight run (via the cancel path) without quitting |
| `/model [id]`           | Show the current model, or switch to another for the next turn |
| `/provider`             | Show the current provider                                      |
| `/context`, `/tokens`   | Show context-window and token counts for the session           |
| `/cost`                 | Show accumulated cost (OpenRouter; `$0` locally)               |
| `/diff`                 | Show the `git diff` of everything changed this session         |
| `/history`, `/messages` | Show the conversation so far                                   |
| `/test [command]`       | Show or set the verification command for the next turn         |
| `/approve`              | Toggle per-command approval on or off mid-session              |
| `/reasoning`            | Toggle reasoning tokens (where the provider supports it)       |
| `/doctor`               | Run the preflight checks inline                                |
| `/quit`, `/exit`        | Leave the TUI (equivalent to Ctrl-C)                           |

Behavior, edge cases, and the test contract live in
[`specs/tui-slash-commands.yaml`](../specs/tui-slash-commands.yaml). (`/memory`
is deferred — see the spec.)

---

## 12. Loop toward a goal — `kodr goal`

A single `kodr run` is one shot. `kodr goal` is the _outer loop_: it re-runs the
task until a model judge confirms your goal is met, or it hits an attempt cap.
Where `--test` is a deterministic gate ("tests pass"), the judge handles a
_fuzzy_ goal a shell command can't express.

```bash
kodr goal "the /health route is documented in the README and has a test" \
  --test "node --test" --max-attempts 4
```

Each attempt is a full `run()` (build + `--test`/heal). After it, a **read-only**
judge inspects the workspace and ends with `VERDICT: MET` or `VERDICT: NOT MET`;
when not met, its feedback is carried into the next attempt as a continuation.
The judge can't edit anything, and a verdict reached without opening a file is
treated as ungrounded and never stops the loop on its own — the same
anti-hallucination guard the [review pass](../specs/review.yaml) uses. The loop
also stops early if two attempts in a row change no files (`stalled`) or a build
errors (`build-error`).

`--json` prints a machine-readable summary (`{ met, reason, attempts, verdicts,
usage, … }`); the process exits `0` only when the goal was met (unless
`--no-fail`). Full contract: [`specs/goal.yaml`](../specs/goal.yaml). For a
_backlog_ of tasks rather than one goal, see the next section.

---

## 13. Drive a whole backlog unattended — the loop scripts

`kodr goal` loops toward _one_ outcome. When you have a list of things to build
and want them built while you're asleep, wrap Kodr in the shipped driver script.
Kodr deliberately doesn't build the loop in — it exposes the seams (`--json`,
exit codes, `--continue`) and the loop is an ordinary shell script you can read
and edit.

Two are shipped:

| Script                                                  | Use it when                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| [`examples/loop.sh`](../examples/loop.sh)               | Every task is checkable by a test command                         |
| [`examples/phased-loop.sh`](../examples/phased-loop.sh) | Some tasks aren't — it adds `GOAL: ` lines, judged by `kodr goal` |

### The flow

**1. Write a `TASKS.md` checklist.** One `- [ ]` line per task, in order:

```markdown
- [ ] Add Company (`name`, `domain`) and Contact (`name`, `email`, `company_id`) with
      full CRUD. Validate input with clear 400s for missing fields and malformed
      email. Add tests per route, including the validation-failure cases.
- [ ] GOAL: every endpoint has an owner check and the README documents all of them
```

**2. Commit it, then launch detached** — a real backlog runs for hours, and a
foreground shell may be culled:

```bash
cd /path/to/your/project
git add -A && git commit -m "checklist"   # the loop needs a baseline to reset to
nohup ./examples/loop.sh >loop.out 2>&1 & disown
```

The commit isn't ceremony: a park runs `git reset --hard` + `git clean -fd`,
and with nothing tracked yet that deletes every untracked file — the checklist
included. Both scripts refuse to start in a repo with no commits rather than
let that happen.

**3. Come back and read `git log`.** That's the deliverable.

### Why you can leave it alone — the ratchet

Each task is one iteration, and only one outcome commits:

- **Green** — the run _completed_, actually changed files, and didn't fail
  `TEST_CMD`. The task's code and its `- [x]` tick land in the **same commit**,
  so a later task can never silently un-tick it.
- **Red** — retries in place with `--continue last`, up to `MAX_ATTEMPTS`. The
  broken code stays on disk for the model to fix, and it sees what it just
  tried. A transient backend error (an HTTP 500, a timeout) backs off first.
- **Gives up** — `git reset --hard` + `git clean -fd` puts the tree back to the
  last green commit, and the task is marked `- [!]` so it isn't picked again.

So the tree is green at every commit, and a failed task can't contaminate the
next one. That's the property that makes an unattended overnight run worth
trusting rather than a random walk.

### Writing a checklist that actually finishes

This is where the value is won or lost:

- **One task per line — no wrapping.** The checklist is read with `grep -m1`,
  which returns a single line, so a task wrapped across two lines would send
  only its first line to the model. The scripts refuse to start on a wrapped
  item rather than truncate it, but write them long and unwrapped from the
  start.
- **One task ≈ one commit's worth of work.** "Build the app" parks; "add the
  Company CRUD routes with validation tests" goes green.
- **Name the files and the acceptance criteria in the task.** The tasks that
  succeed first-try read like a small PR description — which module, which
  behaviour, which test cases.
- **`TEST_CMD` is the gate, so every task must be able to pass it.** A task
  whose success would break an existing test will burn every attempt and park.
- **Order matters.** Each task starts from the previous one's commit, so put
  scaffolding first; a task can't depend on something later in the list.
- **Use `GOAL: ` only where a test command genuinely can't express "done"** —
  "every endpoint has an owner check", "the README documents all of it". Most
  of a real build is crisply testable; keep the judge for the rest.
  [`examples/crm/`](../examples/crm/) is a worked 15-phase
  plan with that mix.

### Config

All environment variables, all optional:

| Var                  | Default         | What it does                                         |
| -------------------- | --------------- | ---------------------------------------------------- |
| `TASKS_FILE`         | `TASKS.md`      | The checklist                                        |
| `TEST_CMD`           | `npm test`      | The gate; empty string disables `--test`             |
| `MAX_ATTEMPTS`       | `3`             | Retries per task before parking                      |
| `GOAL_MAX_ATTEMPTS`  | `4`             | `kodr goal` attempts per `GOAL: ` line (phased only) |
| `TOOL_TURNS`         | `30`            | Tool-turn ceiling per attempt                        |
| `RUN_MS`             | `900000`        | Wall-clock budget per attempt                        |
| `REQUEST_TIMEOUT_MS` | kodr's `600000` | Per-request ceiling; raise for a big local model     |
| `RETRY_BACKOFF_S`    | `5`             | Pause before retrying a _transient_ error            |
| `RESET_PATHS`        | _(empty)_       | Gitignored paths to wipe on park — see below         |

```bash
MAX_ATTEMPTS=5 TEST_CMD="node --test" RESET_PATHS=data ./examples/loop.sh
```

### Reading the results

```bash
git log --oneline          # one commit per green task — the actual output
grep '^- \[!\]' TASKS.md   # what parked, and needs you
kodr stats                 # heal / retry / verify rates across the whole run
tail -f loop.out           # live progress while it runs
```

Parked tasks are the interesting ones: their run transcripts are in
`.kodr/runs/`, and `kodr replay last` re-runs one from scratch to see whether it
reproduces.

### Gotchas

- **Needs `jq`, `git`, and bash ≥ 4.4.** macOS ships bash 3.2 — make sure
  `env bash` finds a newer one (Homebrew's).
- **`git reset --hard` only reverts _tracked_ files.** A database or cache a
  parked task migrated survives and poisons every later task. Set
  `RESET_PATHS="data"` (space-separated) to wipe those on park; it refuses `.`,
  `..`, `.git`, absolute paths, and traversal.
- **Don't add `loop.out`/`loop.log` to your project's `.gitignore`.** The script
  registers them in `.git/info/exclude` itself, along with `.kodr/` — which is
  what keeps a parked attempt's transcript from being deleted by the park.

Deep dives, including the live failures behind each of these rules:
[`examples/loop.md`](../examples/loop.md),
[`examples/phased-loop.md`](../examples/phased-loop.md). Contract:
[`specs/loop-scripts.yaml`](../specs/loop-scripts.yaml).

---

## Utility commands

Beyond `run` and `tui`, Kodr ships a handful of read-mostly subcommands:

| Command                    | What it does                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `kodr models`              | List models and their loaded-vs-max context windows; flag unused headroom                                            |
| `kodr doctor`              | Preflight the provider, model, git, and Node version; exit non-zero only on a real failure                           |
| `kodr stats`               | Aggregate rates (heal, retry, compaction, verify) across saved runs                                                  |
| `kodr replay <last\|path>` | Re-run a saved run's _original_ prompt fresh, to check whether a failure reproduces                                  |
| `kodr acp`                 | Serve Kodr as an [ACP](https://agentclientprotocol.com) agent over stdio for an editor (see [`docs/acp.md`](acp.md)) |

```bash
kodr models
kodr stats
kodr replay last        # rerun the last run's own prompt, no prior conversation
```

## Diagnostics — `--debug`

When a model response comes back malformed, `--debug` (or `KODR_DEBUG`)
writes every request's raw request/response text to a `<timestamp>-debug.jsonl`
sidecar next to the run transcript in `.kodr/runs/` — one line per HTTP
attempt. Off by default; reach for it when the message and token counts alone
don't explain what went wrong.

## Where things get written

Runs are saved under `.kodr/` in the workspace:

- `.kodr/runs/` — one JSON transcript per run (plus any `--debug` sidecar);
  what `--continue`, `replay`, and `stats` read. Change the location with
  `--runs-dir` / `KODR_RUNS_DIR`, or skip saving with `--no-save`. Add `.kodr/`
  to your `.gitignore` — it's diagnostic output, not source. (The loop scripts
  do this for you, repo-locally.)
- `.kodr/hooks.json` — SessionStart/Stop/tool hooks (see
  [`specs/hooks.yaml`](../specs/hooks.yaml)).
- `.kodr/skills/<name>/SKILL.md` — workspace skills the model can load on
  demand (see [`specs/skills.yaml`](../specs/skills.yaml)).
- `KODR.md` / `AGENTS.md` — your workspace instructions, read into the system
  prompt.
- `MEMORY.md` — durable lessons, only ever written with a human decision
  (`--memory`).

## Cheat sheet

```bash
# Local, auto-detected model, no setup
kodr "add a --version flag to the CLI"

# Verify and self-heal
kodr "fix the flaky test in test/parser.test.mjs" --test "node --test"

# Interactive, multi-turn, with command approval
kodr tui --approve-commands --test "npm test"

# Hosted model with reasoning
kodr "explain and refactor this module" \
  --provider openrouter --model qwen/qwen3.6-35b-a3b --reasoning

# Continue where you left off, then compact
kodr "now add pagination" --continue last
kodr "/compact" --continue last

# Check the environment before a big run
kodr doctor

# Build a whole TASKS.md backlog overnight, committing each task as it goes
nohup ./examples/loop.sh >loop.out 2>&1 & disown
```

For the full flag reference, run `kodr --help`.
