# Kodr

A coding agent for local and hosted models. Give it a task; it edits your
project, runs your tests, and attempts repairs when they fail.

Use it from the terminal, an interactive session, or an editor. Supports
LM Studio, Ollama, and OpenRouter. Node.js 22+, zero runtime dependencies.

## Quick start

You need **Node.js 22+** and a model that supports tool calling. For the
default setup, load a tool-capable model in **LM Studio** and start its local
API server on port **1234**. Using Ollama or OpenRouter instead?
See [provider setup](docs/providers.md).

Install Kodr:

```bash
npm install -g github:paulkohler/kodr2
```

Then switch to the project you want to work on:

```bash
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

Prefer running from a clone? See [installation from source](docs/usage.md#install-from-source).

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
| Follow a complete example | [Build a TODO API](examples/todo-express.md) |

Run `kodr --help` for the complete command and flag reference.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development tools and checks.
Features are specified in [YAML specs](specs/) before implementation.
Report vulnerabilities using the [security policy](SECURITY.md).

This is a rebuild of the original Kodr; [the background](https://paulkohler.me/blog/2026-07-07-kodr2-starting-over/)
explains why. Released under the [MIT License](LICENSE).
