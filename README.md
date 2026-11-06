# Kodr

A coding agent for local and hosted models. Give it a task; it edits your
project, runs your tests, and attempts repairs when they fail.

Use it from the terminal, an interactive session, or an editor. Supports
LM Studio, Ollama, and OpenRouter. Node.js 22+, zero runtime dependencies.

## Quick start

You need **Node.js 22+**, **Git**, and a model that supports tool calling. For the
default setup, load a tool-capable model in **LM Studio** and start its local
API server on port **1234**. Using Ollama or OpenRouter instead?
See [provider setup](docs/providers.md).

Try the included bug-fixing demo directly from a clone. No npm install or
build step is needed:

```bash
git clone https://github.com/paulkohler/kodr2.git
cd kodr2
node bin/kodr.mjs doctor
node bin/kodr.mjs "Fix the bug in slugify.mjs without changing the tests" --cwd examples/quickstart --test "node --test"
git diff -- examples/quickstart
```

The demo turns titles into URL slugs: `Hello, World!` should become
`hello-world`. Its function is deliberately broken. Kodr reads the files,
edits the function, and runs the six provided tests. **Success means all six
tests pass and the diff shows the function fixed with the tests unchanged.**
You can check the tests yourself with `node --test examples/quickstart/slugify.test.mjs`.
See the [demo guide](examples/quickstart/README.md) to inspect the initial
failure or reset it for another try.

`doctor` checks connectivity and model selection; it does not test tool
calling. If it cannot connect, start LM Studio's API server and check port
1234. For another address, pass `--base-url http://HOST:PORT/v1` to both
commands. If it selects the wrong model, use `node bin/kodr.mjs models`
and pass `--model MODEL_ID` to both commands.

## Use it on your project

Install the `kodr` command, then switch to the project you want to change:

```bash
npm install -g github:paulkohler/kodr2
cd /path/to/your/project
kodr doctor
kodr "fix the failing test" --test "npm test"
```

Replace the task and test command with ones appropriate to your project.
Kodr streams its work, runs the test command if files changed, and attempts
up to three repair turns if verification fails. Inspect the changes with
`git diff` and `git status` afterward.

Kodr writes files and can execute shell commands with your user permissions.
For per-command approval while working interactively:

```bash
kodr tui --approve-commands --test "npm test"
```

To keep using your clone, run `node bin/kodr.mjs "your task" --cwd /path/to/your/project`
from the Kodr directory, or [install a command for your clone](docs/usage.md#install-from-source).

## Keep working

```bash
# Continue the last conversation
kodr "now add error handling" --continue last

# Work interactively with follow-up prompts
kodr tui

# Work through a committed TASKS.md checklist
kodr loop --test "npm test"
```

The loop commits successful tasks and reverts failed attempts when it gives
up. Read the [backlog guide](docs/loop.md) before an unattended run.

## Guides

| I want to… | Read |
| --- | --- |
| Run tasks, verify changes, and continue a conversation | [Everyday usage](docs/usage.md) |
| Configure LM Studio, Ollama, or OpenRouter | [Providers](docs/providers.md) |
| Use the interactive terminal and slash commands | [Terminal UI](docs/tui.md) |
| Add a second model to review changes | [Code review](docs/review.md) |
| Tune limits, inspect runs, or manage memory | [Run management](docs/runs.md) |
| Work through a backlog | [Unattended loops](docs/loop.md) |
| Connect Kodr to an editor | [Editor integration](docs/acp.md) |
| Sandbox an unattended run | [OpenShell isolation](docs/openshell-isolation.md) |
| Follow a complete example | [Build a TODO API](examples/todo-express.md) |

Run `kodr --help` for the complete command and flag reference.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development tools and checks.
Features are specified in [YAML specs](specs/) before implementation.
Report vulnerabilities using the [security policy](SECURITY.md).

This is a rebuild of the original Kodr; [the background](https://paulkohler.me/blog/2026-07-07-kodr2-starting-over/)
explains why. Released under the [MIT License](LICENSE).
