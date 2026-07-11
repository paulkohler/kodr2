# Kodr

A one-shot coding harness for local and hosted LLMs. Zero dependencies, Node.js 22+.

> **IDE type support:** the zero-dependency guard keeps type packages out of
> `package.json`, so a fresh clone has no JSDoc IntelliSense out of the box.
> Run `npm install --no-save @types/node` to get it (see
> [CONTRIBUTING.md](CONTRIBUTING.md)).

Kodr reads a prompt, assembles workspace context, lets the model use tools to read and write files, optionally verifies the result, and heals if verification fails. Works against LM Studio, Ollama (local or cloud), or OpenRouter — see [Providers](#providers).

> **Note:** kodr2 is a from-scratch rebuild of the original [kodr](https://github.com/paulkohler/kodr), which grew to 264 numbered phases and became hard to reason about. This repo restarts spec-first: every feature gets a YAML spec in `specs/` before it's implemented, and spec status moves `proposed → accepted → implemented → deprecated`. The original is kept as a frozen archive — see [the switchover post](https://paulkohler.me/blog/2026-07-07-kodr2-starting-over/) for why.

## Quick start

Clone the repo and install a local shim (writes `~/.local/bin/kodr` by
default; make sure that directory is on your `PATH`):

```bash
git clone https://github.com/paulkohler/kodr2.git
cd kodr2
npm run install-local
```

Override the destination with `--dir`/`--name`, e.g.
`node bin/install-local.mjs --dir ./bin-local --name kodr-dev`.

Alternatively, install globally from GitHub via npm:

```bash
npm install -g github:paulkohler/kodr2
```

Either way, once `kodr` is on your `PATH`:

```bash
# Run a coding task
kodr run "add input validation to server.mjs"

# Shorthand
kodr "fix the failing test"

# With verification
kodr "refactor the auth module" --test "node --test"

# Continue from last run
kodr "now add error handling" --continue last
```

For a worked multi-turn example — scaffolding an Express TODO API and
extending it across several `--continue` turns — see
[examples/todo-express.md](examples/todo-express.md).

## Requirements

- Node.js 22+
- A tool/function-calling-capable model, served by one of:
  - **LM Studio**, running locally (default: `http://localhost:1234`) — the default provider, no setup needed beyond that
  - **Ollama**, local (default: `http://localhost:11434`) or Ollama's hosted cloud API
  - **OpenRouter**, hosted (`OPENROUTER_API_KEY` required)

  See [Providers](#providers) for how to pick one and what differs between them.

## How it works

```
prompt → context assembly → model + tools loop → verify → heal → done
```

1. **Context** — reads workspace instructions (`KODR.md` or `AGENTS.md`) and builds a file listing
2. **Model + tools** — streams the model response; when it calls tools (read_file, write_file, etc.), executes them and continues
3. **Verify** — if `--test` is set and files were changed, runs the test command
4. **Heal** — if verification failed, feeds the failure back to the model for up to 3 repair turns

Long runs stay inside the model's context window through **compaction**: between
tool turns, once the live prompt crosses 80% of the context window, the older
message history is summarized into one dense message and replaces it. The system
prompt is kept verbatim and the tools stay available (they are supplied fresh on
every model call), so only the history shrinks. The window is detected on
startup from the model's real context length where the provider can report one
(LM Studio's `/api/v0/models`; OpenRouter's `/models`) and otherwise falls back
to a built-in default (Ollama's `/v1/models` doesn't report one); override it
with `--context-window` (or `KODR_CONTEXT_WINDOW`), and `0` disables it. You can
also compact a saved conversation on demand: `kodr "/compact" --continue last`.

Because LM Studio often loads a model far below the context length it supports,
`kodr models` lists every LM Studio model with its loaded vs. max window and
flags any with unused headroom — and a run warns when the loaded window could
be much larger. A bigger window means longer sessions and fewer compactions,
at the cost of memory. On OpenRouter/Ollama, which have no "loaded" concept,
`kodr models` just lists the available model ids.

```
$ kodr models
● google/gemma-4-26b-a4b  loaded 32768 / 262144 max  ⚠ 8× headroom
○ openai/gpt-oss-20b      131072 max
```

`kodr doctor` checks the environment a run would use -- the resolved
provider's reachability, a usable model, git, and the Node.js version -- and
reports problems before a task fails mid-run with a bare connection error.
Read-only; exits non-zero only if a check actually fails (warnings don't
affect the exit code).

```
$ kodr doctor
kodr doctor

  ✓ Node.js version -- v24.16.0
  ✓ LM Studio -- reachable at http://localhost:1234/v1
  ✓ model -- google/gemma-4-26b-a4b
  ✓ git -- git version 2.53.0

ok
```

`--debug` (or `KODR_DEBUG`) writes every model request's raw request and raw,
unparsed response text to a `<timestamp>-debug.jsonl` sidecar next to the run
transcript in `.kodr/runs/` -- one line per HTTP attempt (a retried request
produces more than one). Off by default; for diagnosing a malformed model
response after the fact, when the assembled message and token counts alone
don't explain what went wrong.

`kodr stats` aggregates every saved run record into summary rates -- heal
success, compaction, retry, verify pass -- so a slow-burn pattern across many
runs (a rising retry rate, a heal success rate trending down) is visible
without hand-rolling a jq/grep pass over `.kodr/runs/*.json`.

```
$ kodr stats
kodr stats 12 runs

  stopped reasons: complete: 11, error: 1
  no-op completions: 8%
  heal attempted: 17%  succeeded: 100%
  compaction rate: 25%  avg per run: 0.33
  retry rate: 8%  avg per run: 0.08
  verify attempted: 92%  passed: 91%
  avg tool turns: 4.2
  avg duration: 18432ms
  total tokens: 48213 in / 6104 out ($0.4213)
```

The cost figure only appears when nonzero -- OpenRouter reports real USD cost
per request; LM Studio and Ollama don't charge per token, so it stays $0
there and the suffix is omitted.

`kodr replay <last|path>` re-runs a saved run's original prompt fresh (no
prior conversation), against the same cwd/model/test command it originally
used, to check whether a failure reproduces or was a one-off model/backend
hiccup. Unlike `--continue` (which extends a prior conversation with a new
instruction), replay starts over with the _same original prompt_:

```
$ kodr replay last
```

## Tools

The model has these tools available:

| Tool          | What it does                                  |
| ------------- | --------------------------------------------- |
| `read_file`   | Read file contents (path-jailed to workspace) |
| `write_file`  | Create or overwrite a file                    |
| `edit_file`   | Search/replace edit on an existing file       |
| `list_files`  | List directory contents (optional recursive)  |
| `search`      | Grep for a pattern across workspace files     |
| `run_command` | Execute a shell command                       |

## Providers

Kodr talks to any OpenAI-compatible chat completions endpoint. Three
providers are built in — pick one with `--provider` (or `KODR_PROVIDER`),
default `lmstudio`:

|                            | `lmstudio` (default)                               | `openrouter`                        | `ollama`                                      |
| -------------------------- | -------------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| Default base URL           | `http://localhost:1234/v1`                         | `https://openrouter.ai/api/v1`      | `http://localhost:11434/v1`                   |
| Auth                       | none                                               | `OPENROUTER_API_KEY` (required)     | `OLLAMA_API_KEY` (optional)                   |
| `--model`                  | optional, auto-detects the loaded model            | **required**                        | optional, auto-detects the first listed model |
| Model load/unload          | explicit, via the `lms` CLI (see `--review-model`) | n/a — model is just a request field | n/a — Ollama manages this itself              |
| Context-window auto-detect | yes                                                | yes                                 | no (falls back to the default)                |
| `--reasoning`              | not supported                                      | supported                           | not supported                                 |
| Per-request cost           | always $0 (local)                                  | real, reported by OpenRouter        | always $0                                     |

```bash
# Default: local LM Studio
kodr "add input validation to server.mjs"

# OpenRouter — hosted, needs an API key, --model is required
export OPENROUTER_API_KEY=sk-or-...
kodr "add input validation to server.mjs" --provider openrouter --model qwen/qwen3.6-35b-a3b

# Ollama — local by default; point --base-url at ollama.com for
# no-local-install hosted access, or just name a ":cloud"-suffixed model
# (e.g. "kimi-k2.7-code:cloud") to offload through a local install instead
kodr "add input validation to server.mjs" --provider ollama --model qwen3-coder:30b
```

**Ollama context length**: Ollama's `/v1/models` reports no context-length
field (unlike LM Studio's `/api/v0/models` or OpenRouter's
`context_length`), so kodr can't auto-detect it and always falls back to its
own conservative default (8192 tokens) for compaction bookkeeping —
regardless of what your Ollama server is actually configured to run at. This
is independent of Ollama's own context setting (the `Context length` slider
in Ollama's app Settings, or `OLLAMA_CONTEXT_LENGTH` if you run `ollama
serve` directly — see `ollama serve --help`), which controls the model's
real usable context and defaults to 4k/32k/256k based on available VRAM. If
you've raised that — e.g. to 256k — tell kodr the same number with
`--context-window 262144` (or `KODR_CONTEXT_WINDOW=262144`) so its
compaction threshold isn't needlessly conservative; kodr compacts at 80% of
whatever value it's given.

**Reasoning** (`--reasoning` / `KODR_REASONING`): asks OpenRouter for
reasoning tokens on every call (`{ reasoning: { enabled: true } }`). Errors
immediately at startup if the resolved provider doesn't support it, rather
than silently running without it. LM Studio's chat completions endpoint has
no reasoning control today ([tracked upstream, open, no
ETA](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1250)).

**OpenRouter privacy defaults**: kodr sends an opinionated
`{ zdr: true, data_collection: "deny" }` on every OpenRouter request by
default — Zero Data Retention routing and a refusal to route through
providers that collect/train on prompt data — since sending code to a hosted
model implies caring about this by default, not only when you remembered to
ask. Turn either off with `--openrouter-no-zdr` /
`--openrouter-allow-data-collection` (or the matching `KODR_OPENROUTER_*` env
vars). Restrict or prioritize which upstream inference provider OpenRouter
routes to with `--openrouter-provider-only akashml,parasail` (or
`KODR_OPENROUTER_PROVIDER_ONLY`) — see [OpenRouter's provider
routing docs](https://openrouter.ai/docs/features/provider-routing).

## CLI options

```
--cwd <path>            Workspace directory (default: .)
--provider <name>       lmstudio, openrouter, or ollama (or KODR_PROVIDER; default: lmstudio)
--base-url <url>        Provider API URL (default: see Providers above)
--model <id>            Model identifier (or KODR_MODEL; auto-detected for lmstudio/ollama;
                         required for openrouter)
--reasoning             Request reasoning tokens (or KODR_REASONING; openrouter only)
--openrouter-no-zdr     Disable OpenRouter Zero Data Retention routing (on by default)
--openrouter-allow-data-collection
                        Allow OpenRouter routing to data-collecting providers (denied by default)
--openrouter-provider-only <a,b>
                        Restrict/prioritize OpenRouter's upstream providers (or KODR_OPENROUTER_PROVIDER_ONLY)
--test <command>        Verification command (e.g. "npm test")
--heal-turns <n>        Max repair turns (default: 3)
--max-tool-turns <n>    Tool-turn ceiling per loop (default: 20)
--heartbeat-ms <n>      "Still running" notice interval for Stop hooks and model requests (or KODR_HEARTBEAT_MS; default: 30000, 0 disables)
--model-retries <n>     Retries for a 5xx chat response, e.g. a local backend crash (or KODR_MODEL_RETRIES; default: 1, 0 disables)
--context-window <n>    Max context tokens; compact at 80% (auto-detected where the provider supports it; 0 disables)
--env <a,b,c>           Extra env vars to expose to commands (CSV of names)
--continue <last|path>  Continue from a prior run
--quiet, -q             Suppress streaming output
```

You can also set the provider and model once for scripts and evals:

```bash
KODR_MODEL=qwen/qwen3.6-35b-a3b kodr "fix the failing test"
KODR_PROVIDER=openrouter KODR_MODEL=qwen/qwen3.6-35b-a3b npm run eval
```

`--model` takes precedence over `KODR_MODEL`, and `--provider` over
`KODR_PROVIDER`. If neither model option is set, lmstudio/ollama auto-detect
from their model listing; openrouter requires one explicitly.

## Command environment

`run_command` and the `--test` verification command run with a minimal,
curated environment — not the harness's full `process.env`. By default only a
small allowlist is passed through (`PATH`, `HOME`, `TMPDIR`, and the common
locale variables), so model-suggested commands can't read secrets that happen
to live in your shell environment.

If a command needs additional variables, allow them by name:

```bash
kodr "run the integration suite" --test "npm run test:int" --env API_BASE_URL,CI
```

Only the named variables that exist in your environment are forwarded; the
values are never shown to the model.

## Workspace instructions

Create a `KODR.md` file in your project root to give the model project-specific context:

```markdown
# My Project

This is a Node.js API using Express.
Tests are in test/ and run with `npm test`.
Follow the existing code style: no semicolons, single quotes.
```

## Development

```bash
# Install development tooling
npm install

# Run unit tests
npm test

# Run integration evals (requires LM Studio)
npm run eval

# Syntax check
npm run check

# JSDoc type check (requires `npm install -g typescript`; see note above)
npm run check:types

# Format
npm run format
```

## Contributing and security

See the repository's
[contribution guide](https://github.com/paulkohler/kodr2/blob/main/CONTRIBUTING.md)
for the development workflow. Report security vulnerabilities privately as
described in the
[security policy](https://github.com/paulkohler/kodr2/blob/main/SECURITY.md).

Kodr is available under the [MIT License](LICENSE).

## Project structure

```
bin/kodr.mjs           CLI entry point
src/
  cli.mjs              Argument parsing
  harness.mjs          Main execution loop
  model.mjs            OpenAI-compatible chat client (shared by every provider)
  provider.mjs         Provider factory (lmstudio/openrouter/ollama selection)
  provider-lmstudio.mjs   LM Studio provider
  provider-openrouter.mjs OpenRouter provider
  provider-ollama.mjs     Ollama provider
  lms.mjs              LM Studio model load/unload via the `lms` CLI
  context.mjs          System prompt assembly
  verify.mjs           Test/check runner
  heal.mjs             Repair loop
  format.mjs           Terminal output formatting
  tools/
    index.mjs          Tool registry
    read-file.mjs      Read file tool
    write-file.mjs     Write file tool
    edit-file.mjs      Edit file tool
    list-files.mjs     List files tool
    search.mjs         Search tool
    run-command.mjs    Run command tool
specs/                 Feature specifications (YAML)
test/                  Unit tests
eval/                  Integration evals
```

## Specs

Features are defined as YAML specs in `specs/`. Each spec describes inputs, outputs, constraints, and required tests. See any file in `specs/` for the format.
