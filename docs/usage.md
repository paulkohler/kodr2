# Using Kodr

This guide covers everyday tasks after the [quick start](../README.md#quick-start).
For all commands and flags, run `kodr --help`.

- [Install from source](#install-from-source)
- [Run a task](#run-a-task)
- [Verify and repair](#verify-and-repair)
- [Continue a conversation](#continue-a-conversation)
- [Give Kodr project instructions](#give-kodr-project-instructions)
- [Command access and environment](#command-access-and-environment)
- [Work toward a goal](#work-toward-a-goal)
- [Other workflows](#other-workflows)

## Install from source

The [quick start](../README.md#quick-start) runs directly from a clone without
installation. To also put that clone's `kodr` command on your PATH:

```bash
git clone https://github.com/paulkohler/kodr2.git
cd kodr2
npm run install-local
```

If you already cloned the repository for the demo, just run
`npm run install-local` from that checkout.

This writes a shim to `~/.local/bin/kodr`; ensure `~/.local/bin` is on your
`PATH`. The shim uses this checkout, so keep it in place. No `npm install`
is required to run Kodr or its unit tests.

To customize the shim location:

```bash
node bin/install-local.mjs --dir ./bin-local --name kodr-dev
```

You can also run `node bin/kodr.mjs` from the checkout and pass
`--cwd /path/to/your/project`. See [Contributing](../CONTRIBUTING.md) for
optional development tools.

## Run a task

From the project you want to change:

```bash
kodr doctor
kodr "add input validation to server.mjs"
```

`kodr run "…"` is equivalent. Kodr reads workspace instructions, builds a
file listing, and lets the model read, search, edit, and create files or run
shell commands. It streams the model's response as it works.

The default is LM Studio on port 1234 with a loaded tool-capable model.
See [Providers](providers.md) to select a model or use Ollama or OpenRouter.

```bash
kodr "fix the failing test" --quiet
kodr "add input validation" --cwd /path/to/your/project
kodr "fix the failing test" --test "npm test" --json
```

`--quiet` suppresses the live token stream. `--json` prints a machine-readable
summary; `--events` streams JSON events for integrations. Inspect both
`git diff` and `git status` after a run so you also notice new files.

Use `--max-output-tokens 4096` (or `KODR_MAX_OUTPUT_TOKENS=4096`) to cap each
model response. The default, `0`, keeps the provider's own default; explicit
`0` also overrides the environment. The cap applies to builds, judges,
reviewers, compaction, and memory calls. Reasoning may consume the allowance.

A response ending with `finish_reason: "length"` is incomplete. Kodr retains
its partial text and reasoning and requests a shorter complete response.
None of that response's tool calls execute; they must be resent in full.
Continuations consume `--max-tool-turns` and obey the time and cost budgets.
Truncated compaction or memory output leaves existing history and memory
intact. The request timeout remains a separate backstop.

## Verify and repair

Give Kodr your project's test command:

```bash
kodr "refactor the auth module" --test "npm test"
kodr "port the parser to the new API" --test "node --test" --heal-turns 5
```

If files changed, Kodr runs the command. If it fails, Kodr feeds the failure
back to the model for up to three repair turns by default. Without `--test`,
completion does not establish that tests pass.

In scripts, a normal run exits nonzero if it fails to complete or verification
fails. `--no-fail` overrides that behavior; use it only when your caller checks
the result itself.

## Continue a conversation

```bash
kodr "scaffold an Express TODO API"
kodr "now add input validation" --continue last
kodr "add pagination to the list endpoint" --continue last
```

`last` selects the most recent saved run in the runs directory. You can also
supply a transcript path. See the [worked TODO API example](../examples/todo-express.md).

For repeated follow-ups, `kodr tui` keeps the conversation going automatically.
The [TUI guide](tui.md) covers command approval, cancellation, and slash commands.

Runs are saved to `.kodr/runs/` by default. Add `.kodr/` to your project's
`.gitignore`. See [Run management](runs.md) for custom locations, replay,
diagnostics, and compaction.

## Give Kodr project instructions

Put project context in `KODR.md` or `AGENTS.md` at the project root:

```markdown
# My project

This is a Node.js API using Express.
Tests are in test/ and run with npm test.
Follow the existing code style: no semicolons, single quotes.
```

For lessons accumulated across runs, see [Memory](runs.md#memory).
Workspace hooks and on-demand skills are described in
[hooks](../specs/hooks.yaml) and [skills](../specs/skills.yaml).

## Command access and environment

File tools restrict paths to the workspace. Shell commands run with your user
permissions and are not confined by those file-tool path checks. Environment
filtering is not an operating-system sandbox.

`run_command` and verification commands inherit a small environment allowlist:
`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, and `TZ`.
To forward additional variables by name:

```bash
kodr "run the integration suite" --test "npm run test:int" --env API_BASE_URL,CI
```

Kodr does not insert those variables' values directly into the model prompt.
Commands can still print values into output the model sees, or read credentials
from files accessible to your user.

In the TUI, request approval before each model-issued shell command:

```bash
kodr tui --approve-commands --test "npm test"
```

This approval applies to `run_command`, not every file edit or your configured
verification command. For a slow model-issued command, use
`--command-timeout-ms`; see [Timeouts and budgets](runs.md#timeouts-and-budgets).

## Work toward a goal

Use `kodr goal` when the desired outcome needs a model's assessment as well
as your tests:

```bash
kodr goal "the /health route is documented in the README and has a test" \
  --test "node --test" --max-attempts 4
```

Each attempt builds and verifies, then a read-only judge inspects the workspace.
If the goal is not met, its feedback goes into the next attempt. The default
cap is three attempts. The loop also stops when two consecutive attempts change no files.
A build that ends in a transient provider error (a request timeout, a 5xx) is
not judged: it waits `--retry-backoff-ms` and the next attempt runs, but it
still spends an attempt, so a dead backend ends the goal.
Ctrl-C or SIGTERM cancels an active attempt or retry wait. In `kodr loop`,
a goal whose every build attempt errors stays unchecked for a later rerun;
the JSON goal summary identifies this with `allErrored: true`.

A judge verdict without sufficient tool use cannot establish that the goal
is met. This differs from the advisory grounding check used by
[code review](review.md). With `--json`, the summary includes the outcome,
attempts, verdicts, and usage. Exit status is zero only when the goal is met,
unless `--no-fail` is set.

## Other workflows

- [Terminal UI](tui.md): interactive sessions and slash commands.
- [Code review](review.md): review findings and optional review gates.
- [Unattended loops](loop.md): a committed checklist, retries, and per-task commits.
- [Editor integration](acp.md): run Kodr through an ACP-speaking editor.
- [Run management](runs.md): budgets, saved runs, diagnostics, and memory.
