# Terminal UI

[Everyday usage](usage.md) · [Providers](providers.md)

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
  (the same mechanism as [continuation](usage.md#continue-a-conversation)) —
  no need to restate context.
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

The usual run settings work here too (`--provider`, `--model`, `--test`, `--cwd`,
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
than swallowed. See the [command reference](#command-reference) below.

## Command reference

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
