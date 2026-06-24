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
--model <id>           Model identifier (auto-detected if omitted)
--test <command>       Verification command (e.g. "npm test")
--heal-turns <n>       Max repair turns (default: 3)
--env <a,b,c>          Extra env vars to expose to commands (CSV of names)
--continue <last|path> Continue from a prior run
--quiet, -q            Suppress streaming output
```

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
node --test eval/

# Syntax check
node --check bin/*.mjs && node --check src/*.mjs && node --check src/tools/*.mjs

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
