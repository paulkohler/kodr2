# Using Kodr

Kodr is a one-shot coding harness: you give it a prompt, it assembles
workspace context, lets a local or hosted model read and write files with
tools, optionally verifies the result, and heals if verification fails.

This page is the practical guide — the most common options first, then the
rest in roughly descending order of how often you reach for them. For the
"what it is / why it exists" overview see the [README](../README.md); for the
exact contracts see the specs in [`specs/`](../specs/).

There are two ways to drive Kodr:

- **One-shot runs** (`kodr "…"`) — fire a task, watch it stream, get the
  result. Scripts and pipelines use this.
- **The interactive TUI** (`kodr tui`) — a full-screen, multi-turn REPL that
  keeps the conversation going across follow-ups. This is the nicest way to
  work by hand, and it's covered in [§3](#3-the-terminal-ui-interactive).

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
- **Multi-turn by default.** A follow-up continues the *same* conversation
  (the same mechanism as `--continue` below) — no need to restate context.
- **One run at a time.** Type a follow-up while a run is active and it's
  *queued* (a single slot, shown in the header); it starts automatically when
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
`--context-window`, …). **Ctrl-C** tears the session down cleanly and
restores your terminal.

### Slash commands

Type a `/`-prefixed word at the start of the input to run a meta-command
instead of sending a prompt to the model. Today one is implemented:

- **`/compact`** — compress the conversation so far into one dense summary
  and keep going, reclaiming context-window room on a long session.

A broader set (`/help`, `/clear`, `/model`, `/diff`, `/stop`, …) is proposed
in [`specs/tui-slash-commands.yaml`](../specs/tui-slash-commands.yaml) — see
[§11](#11-slash-commands-for-the-tui-proposed) for the full list.

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

After a successful build, run a review pass on a *different* model. Kodr owns
the LM Studio load/unload/verify sequencing for both models via the `lms`
CLI, so you can build on a fast model and review on a stronger one.

```bash
kodr "…" --review-model qwen/qwen3.6-35b-a3b
```

Related tuning: `--review-context-window`, `--review-min-tool-calls`,
`--review-max-tool-turns` (see [`specs/review.yaml`](../specs/review.yaml)).

## 11. Slash commands for the TUI (proposed)

Slash commands are TUI meta-commands: they act on the *session* — the
conversation, the config, the view — rather than being sent to the model as a
prompt. `/compact` ([§6](#6-keep-long-sessions-alive--context-window--compact))
is the only one implemented today. The following set is **proposed** in
[`specs/tui-slash-commands.yaml`](../specs/tui-slash-commands.yaml); it's a
design sketch, not yet built.

| Command | What it would do |
| --- | --- |
| `/help`, `/?` | List the available slash commands and their descriptions |
| `/compact` | Compress the conversation into a summary and continue *(implemented)* |
| `/clear`, `/new` | Start a fresh conversation, dropping the prior history |
| `/retry` | Re-run the last prompt fresh, discarding that turn's result |
| `/stop`, `/cancel` | Abort the in-flight run (uses the existing cancel path) without quitting |
| `/model [id]` | Show the current model, or switch to another for the next turn |
| `/provider [name]` | Show the current provider |
| `/context`, `/tokens` | Show context-window usage and token counts for the session |
| `/cost` | Show accumulated cost (OpenRouter; `$0` locally) |
| `/diff` | Show the git diff of everything changed this session |
| `/history`, `/messages` | Show the conversation so far |
| `/test [command]` | Show or set the verification command for the next turn |
| `/approve` | Toggle per-command approval on or off mid-session |
| `/reasoning` | Toggle reasoning tokens (where the provider supports it) |
| `/memory` | Review and apply proposed memory notes for this workspace |
| `/doctor` | Run the preflight checks inline |
| `/quit`, `/exit` | Leave the TUI (equivalent to Ctrl-C) |

Design notes — how these behave, edge cases, and the test contract — live in
the spec. It's marked `proposed`, so treat it as a starting point for
discussion: prune, rename, or add before anything gets built.

---

## Utility commands

Beyond `run` and `tui`, Kodr ships a handful of read-mostly subcommands:

| Command | What it does |
| --- | --- |
| `kodr models` | List models and their loaded-vs-max context windows; flag unused headroom |
| `kodr doctor` | Preflight the provider, model, git, and Node version; exit non-zero only on a real failure |
| `kodr stats` | Aggregate rates (heal, retry, compaction, verify) across saved runs |
| `kodr replay <last\|path>` | Re-run a saved run's *original* prompt fresh, to check whether a failure reproduces |
| `kodr acp` | Serve Kodr as an [ACP](https://agentclientprotocol.com) agent over stdio for an editor (see [`docs/acp.md`](acp.md)) |

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
  `--runs-dir` / `KODR_RUNS_DIR`, or skip saving with `--no-save`.
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
```

For the full flag reference, run `kodr --help`.
