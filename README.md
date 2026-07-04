# Kodr

A one-shot coding harness for LM Studio. Zero dependencies, Node.js 22+.

Kodr reads a prompt, assembles workspace context, lets the model use tools to read and write files, optionally verifies the result, and heals if verification fails.

## Quick start

```bash
# Install globally from GitHub
npm install -g github:paulkohler/kodr2

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
- LM Studio running locally (default: `http://localhost:1234`)
- A model loaded in LM Studio with tool/function calling support

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
startup from the model's loaded context length (LM Studio's `/api/v0/models`);
override it with `--context-window` (or `KODR_CONTEXT_WINDOW`), and `0` disables
it. You can also compact a saved conversation on demand:
`kodr "/compact" --continue last`.

Because LM Studio often loads a model far below the context length it supports,
`kodr models` lists every model with its loaded vs. max window and flags any
with unused headroom — and a run warns when the loaded window could be much
larger. A bigger window means longer sessions and fewer compactions, at the cost
of memory.

```
$ kodr models
● google/gemma-4-26b-a4b  loaded 32768 / 262144 max  ⚠ 8× headroom
○ openai/gpt-oss-20b      131072 max
```

`kodr doctor` checks the environment a run would use -- LM Studio
reachability, a loaded model, git, and the Node.js version -- and reports
problems before a task fails mid-run with a bare connection error. Read-only;
exits non-zero only if a check actually fails (warnings don't affect the exit
code).

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
  total tokens: 48213 in / 6104 out
```

`kodr replay <last|path>` re-runs a saved run's original prompt fresh (no
prior conversation), against the same cwd/model/test command it originally
used, to check whether a failure reproduces or was a one-off model/backend
hiccup. Unlike `--continue` (which extends a prior conversation with a new
instruction), replay starts over with the *same original prompt*:

```
$ kodr replay last
```

## Tools

The model has these tools available:

| Tool | What it does |
|---|---|
| `read_file` | Read file contents (path-jailed to workspace) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Search/replace edit on an existing file |
| `list_files` | List directory contents (optional recursive) |
| `search` | Grep for a pattern across workspace files |
| `run_command` | Execute a shell command |

## CLI options

```
--cwd <path>           Workspace directory (default: .)
--base-url <url>       LM Studio URL (default: http://localhost:1234/v1)
--model <id>           Model identifier (or KODR_MODEL; auto-detected if omitted)
--test <command>       Verification command (e.g. "npm test")
--heal-turns <n>       Max repair turns (default: 3)
--max-tool-turns <n>   Tool-turn ceiling per loop (default: 20)
--heartbeat-ms <n>     "Still running" notice interval for Stop hooks and model requests (or KODR_HEARTBEAT_MS; default: 30000, 0 disables)
--model-retries <n>    Retries for a 5xx chat response, e.g. a local backend crash (or KODR_MODEL_RETRIES; default: 1, 0 disables)
--context-window <n>   Max context tokens; compact at 80% (auto-detected; 0 disables)
--env <a,b,c>          Extra env vars to expose to commands (CSV of names)
--continue <last|path> Continue from a prior run
--quiet, -q            Suppress streaming output
```

You can also set the model once for scripts and evals:

```bash
KODR_MODEL=qwen/qwen3.6-35b-a3b kodr "fix the failing test"
KODR_MODEL=qwen/qwen3.6-35b-a3b npm run eval
```

`--model` takes precedence over `KODR_MODEL`. If neither is set, kodr uses the
first model reported by LM Studio's OpenAI-compatible `/v1/models` endpoint.

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
  model.mjs            LM Studio client
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
