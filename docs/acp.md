# ACP — Agent Client Protocol in Kodr

Kodr implements the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP): it runs as an ACP *agent* so any ACP-speaking editor can drive it as an
embeddable coding agent, instead of the CLI or TUI. This doc covers how to use
that (including from VS Code) and how it's built. The core idea: ACP mode is a
**fifth reporter** plus a **second approval channel** — the same two seams the
interactive TUI uses, so nothing in the run loop changes.

Status: implemented — [`specs/acp.yaml`](../specs/acp.yaml),
[`src/acp.mjs`](../src/acp.mjs), [`src/acp-protocol.mjs`](../src/acp-protocol.mjs),
[`src/acp-reporter.mjs`](../src/acp-reporter.mjs), [`src/acp-backend.mjs`](../src/acp-backend.mjs),
launched by `kodr acp`. This document is how to use it and the design behind it;
the spec is the contract. What's built covers `initialize`, `session/new`,
`session/prompt` (one `run()` per prompt, streamed as `session/update`),
`session/request_permission` for `run_command`, `session/cancel` (aborts the
in-flight model request for real via an `AbortSignal` threaded through `run()` —
see [`specs/cancel.yaml`](../specs/cancel.yaml)), and `fs/*` / `terminal/*`
delegation to the client, gated on the capabilities it advertises at
`initialize` (below). Prompts are text-only for now (`session/prompt`
image/audio blocks are ignored); multimodal is a later increment.

## Using Kodr from an editor

Kodr is an ACP **agent**: the client (your editor) launches it as a subprocess
and talks JSON-RPC over its stdio. The launch command is `kodr acp` — or
`node bin/kodr.mjs acp` from a checkout. It owns stdin/stdout as the protocol
channel, needs no TTY, and takes no prompt. A model backend must be reachable:
Kodr defaults to LM Studio at `localhost:1234` (load a tool-capable model);
`--provider openrouter` (with `OPENROUTER_API_KEY`) or `--provider ollama`
work too.

### VS Code

VS Code has no built-in ACP client, but community extensions provide one. These
steps use **ACP Client** ([`formulahendry.acp-client`](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client));
other ACP-client extensions work the same way, differing only in the settings key.

1. Install **ACP Client** from the Marketplace (search "ACP Client").
2. Register Kodr as a custom agent in `settings.json`:

   ```json
   "acp.agents": {
     "Kodr": {
       "command": "node",
       "args": ["/absolute/path/to/kodr/bin/kodr.mjs", "acp"],
       "env": {}
     }
   }
   ```

   If Kodr is installed globally (`node bin/install-local.mjs`), use
   `"command": "kodr", "args": ["acp"]` instead. For a hosted provider, add the
   flag to `args` and the key to `env` — e.g.
   `"args": [".../bin/kodr.mjs", "acp", "--provider", "openrouter"]` with
   `"env": { "OPENROUTER_API_KEY": "sk-..." }`.
3. Open the ACP panel from the Activity Bar (or run **ACP: Connect to Agent**
   from the command palette), pick **Kodr**, and chat. The extension passes your
   open workspace folder as the session's working directory, so Kodr operates on
   the project you have open.

In the editor you get: streamed model text and a live tool-call/plan view (from
`session/update`), an approval prompt before every `run_command`
(`session/request_permission`), and a cancel that actually interrupts the
in-flight model request (`session/cancel`). If the extension advertises the
`fs/*` / `terminal/*` client capabilities, Kodr delegates reads, writes, and
commands to the editor; if not, it operates directly on the workspace files on
disk (still correct for a local editor) — see *Delegating fs and terminal*
below.

**Resuming the last conversation.** These ACP extensions don't yet get a session
list from Kodr (the non-standard `session/list` method isn't implemented). If you
just want each launch to *continue* your last conversation, add `--continue`,
`last` to the args: `"args": [".../bin/kodr.mjs", "acp", "--continue", "last"]`.
The model then resumes with full context from the previous run; note the chat
pane still starts empty (Kodr doesn't replay history — see the front-end section).

### Other editors, and the current state of ACP

`kodr acp` is client-agnostic — anything that speaks ACP as a *client* can drive
it, and Kodr gains each editor the moment that editor (or an extension) ships
ACP-client support, with no change on Kodr's side. What varies today is whether
a given editor can act as an ACP client at all:

| Editor          | ACP-client support (as of early 2026)                             |
|-----------------|-------------------------------------------------------------------|
| **Zed**         | Native — add `kodr acp` as a custom agent server in Zed settings.  |
| **VS Code**     | Via a community extension (above).                                 |
| **JetBrains**   | Official ACP client — point it at `kodr acp`.                      |
| **Cursor**      | No native ACP-*client* host yet — Cursor instead exposes its *own* agent over ACP (for JetBrains). As a VS Code fork it may run a VS Code ACP extension from Open VSX, but that path is unverified. |
| **Antigravity** | ACP-client support is an open feature request, not yet shipped; same VS Code-fork caveat. |

The distinction that trips people up: some tools (Cursor, Gemini CLI, Claude
Code) ship an ACP *agent* — the same role Kodr plays — so you can't point one at
the other. To drive Kodr you need a *client* (an editor host), which today means
Zed, JetBrains, or a VS Code ACP extension.

## What ACP is (the light touch)

ACP is a JSON-RPC 2.0 protocol spoken over stdio between two roles:

- **Agent** — a program that drives an LLM to read and modify code. That's Kodr.
- **Client** — usually an editor (Zed, a VS Code extension, a custom UI) that
  owns the environment: the files, the terminal, and the human. The client
  launches the agent as a subprocess and talks to it over stdin/stdout.

It exists so that one agent binary can plug into any ACP-speaking editor, and
one editor can drive any ACP-speaking agent — the same decoupling USB gives
hardware. Instead of every editor writing a bespoke integration for every
agent, both sides implement one protocol.

Two message shapes: **methods** (request → response) and **notifications**
(one-way, fire-and-forget). Everything is line-delimited JSON-RPC. All file
paths are absolute; line numbers are 1-indexed.

### The methods, by direction

**Client → Agent**

| Method                    | Purpose                                                    |
|---------------------------|-----------------------------------------------------------|
| `initialize`              | Handshake: negotiate protocol version and capabilities.   |
| `authenticate`            | Authenticate, if the agent requires it.                   |
| `session/new`             | Start a fresh conversation session.                       |
| `session/load`            | Resume a prior session (optional).                        |
| `session/prompt`          | Send a user turn; resolves with a `StopReason`.           |
| `session/cancel`          | Interrupt the current turn (notification).                |
| `session/set_mode`        | Switch operating modes (optional).                        |

**Agent → Client**

| Method                      | Purpose                                                    |
|-----------------------------|-----------------------------------------------------------|
| `session/update`            | Stream progress: text, tool calls, plans (notification).  |
| `session/request_permission`| Ask the human to authorize a tool call before it runs.    |

**Client-provided capabilities the agent may call**

| Method                                                 | Purpose                     |
|--------------------------------------------------------|-----------------------------|
| `fs/read_text_file`, `fs/write_text_file`              | Read/write through the editor, so unsaved buffers and the editor's own view of the workspace stay authoritative. |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | Run commands in the editor's terminal instead of the agent's own child process. |

### A prompt turn

`session/prompt` opens a turn. While the model works, the agent streams
`session/update` notifications carrying:

- `plan` — the intended approach as prioritized tasks;
- `agent_message_chunk` / `agent_thought_chunk` — streamed model text/reasoning;
- `tool_call` — a tool invocation, initially `pending`;
- `tool_call_update` — status transitions `pending → in_progress → completed | failed`, plus content and diffs;
- `usage_update` — token/cost counters.

Before a side-effecting tool runs, the agent may send
`session/request_permission` with a set of options (allow once, allow always,
reject) and wait for the client's choice. The turn ends when
`session/prompt` resolves with a `StopReason`: `end_turn`, `max_tokens`,
`max_turn_requests`, `refusal`, or `cancelled`.

## What interfaces it enables for a harness

Speaking ACP means Kodr stops being only a CLI and becomes an **embeddable
agent**. Concretely:

- **Editor integration for free.** Any ACP client — Zed today, others as they
  adopt it — can drive Kodr against a local LM Studio / Ollama model or
  OpenRouter, with the editor rendering the stream, the diffs, and the
  approval prompts in its own native UI.
- **Client-owned file and terminal access.** With `fs/*`, edits and reads go
  through the editor, so unsaved buffers count and the human sees changes land
  in their own view. With `terminal/*`, `run_command` executes in the editor's
  terminal — visible, cancellable, and inside the editor's sandbox rather than
  Kodr's own child process.
- **Structured permission UX.** `session/request_permission` is a richer,
  bidirectional version of what `--approve-commands` already does in the TUI.
- **A stable, typed event stream.** Editors consume `session/update` instead
  of scraping stdout. Kodr's `--events` NDJSON is the same idea, but one-way
  and Kodr-specific; ACP is the interoperable, bidirectional form.

## How Kodr implements it

The whole design already existed in miniature. Read
[`src/reporter.mjs`](../src/reporter.mjs) — the run's one-way output channel — and
its own doc comment: *"The interactive TUI is a fourth reporter that pushes
events into its render state."* An ACP agent is the fifth. The mapping is
almost mechanical because the harness ([`src/harness.mjs`](../src/harness.mjs))
already threads two injectable seams through every run:

1. `options.reporter` — where every streamed token, tool call, notice, and
   summary goes.
2. `options.confirm` — an async `(call) => Promise<{ approved }>` the tool
   loop awaits before a gated `run_command`, enabled by
   `options.approveCommands`.

### The two seams, mapped to ACP

**Reporter → `session/update`.** Kodr's reporter methods line up almost
one-to-one with ACP update variants:

| Reporter method            | ACP `session/update` variant             |
|----------------------------|-------------------------------------------|
| `token(text)`              | `agent_message_chunk`                     |
| `toolCall({ name, args })` | `tool_call` (status `pending`/`in_progress`) |
| `toolResult({ name, result })` | `tool_call_update` (`completed`/`failed`, with content/diff) |
| `phase(name)`              | `plan` update (build/verify/heal/review)  |
| `verification(result)`     | `tool_call_update` or a diagnostic chunk  |
| `summary(result)` `.usage` | `usage_update`                            |
| `notice`, `heartbeat`      | diagnostic `agent_message_chunk`s         |

So an `createAcpReporter(session)` — sibling to `createTuiReporter` in
[`src/tui-reporter.mjs`](../src/tui-reporter.mjs) — translates each method into a
`session/update` notification written to stdout as JSON-RPC. That is the
entire "connect to the channel like the terminal UI does" story: the TUI
reporter mutates render state and asks for a redraw; the ACP reporter
serializes a notification and writes a line. Same seam, different sink.

**`confirm` → `session/request_permission`.** The TUI's `confirm(call)`
(see [`src/tui.mjs`](../src/tui.mjs)) pops an approval prompt and resolves
`{ approved }` on a keypress. The ACP `confirm(call)` instead sends a
`session/request_permission` request and resolves `{ approved }` from the
client's reply. Identical contract, remote human.

### The ACP front-end (src/acp.mjs)

The JSON-RPC transport and method dispatcher — the ACP analogue of `runTui` in
[`src/tui.mjs`](../src/tui.mjs) — live in [`src/acp.mjs`](../src/acp.mjs)
(`runAcp(options)`), launched by the `kodr acp` subcommand in
[`src/cli.mjs`](../src/cli.mjs). It:

- Reads line-delimited JSON-RPC from stdin and writes it to stdout. Zero
  dependencies — `node:readline` over `process.stdin`, the same constraint the
  TUI lives under. The pure protocol plumbing (the JSON-RPC connection, the
  StopReason and tool-kind maps, the capability descriptor) sits in
  [`src/acp-protocol.mjs`](../src/acp-protocol.mjs), I/O-free and unit-testable.
- Handles `initialize` by advertising its agent capabilities and capturing the
  client's `clientCapabilities` — which gate `fs/*` / `terminal/*` delegation
  (below).
- Maps `session/new` to a fresh in-memory session (a deterministic `sess_<n>`
  id and the client-provided cwd). Within a session, each prompt threads the
  prior run's messages so a multi-turn conversation continues — the same
  continuation the CLI's `--continue` uses. **Launching with `kodr acp --continue
  <ref>`** (`last` or a run id) seeds the *first* session with a prior run's
  conversation, so the model resumes it across an editor relaunch (one-shot;
  later sessions start fresh). This gives the model memory, not visible history:
  it does not replay the prior turns to the client, so the editor's chat pane
  starts empty. Full cross-process resume by id with history replay
  (`session/load`) is not implemented; `initialize` advertises
  `loadSession: false`.
- Maps each `session/prompt` to one `run(prompt, options)` call, streaming
  through the ACP reporter and gating `run_command` through the client, then
  resolves the JSON-RPC response with a `StopReason` translated from the
  returned `RunResult.stoppedReason`.
- Honors `session/cancel` by aborting the run's `AbortSignal` so the turn
  returns `cancelled` (see [`specs/cancel.yaml`](../specs/cancel.yaml)).

### StopReason mapping

`RunResult.stoppedReason` already carries the outcome; translation is a small
table:

| Kodr `stoppedReason` | ACP `StopReason`                    |
|----------------------|-------------------------------------|
| `complete`           | `end_turn`                          |
| `budget-exceeded`    | `max_turn_requests` (or `cancelled`)|
| tool-turn limit hit  | `max_turn_requests`                 |
| `error`              | surfaced as a JSON-RPC error / `refusal` |
| client cancellation  | `cancelled`                         |

### Delegating fs and terminal to the client (implemented)

The file and command tools do their byte I/O through an injectable
**`ToolBackend`** ([`src/tools/backend.mjs`](../src/tools/backend.mjs)) rather than
touching `node:fs` / the shell directly: `read_file`/`write_file`/`edit_file`
go through `readTextFile`/`writeTextFile`, and `run_command` through
`runCommand`. The default is the local, in-process backend, so a run with no
override is byte-for-byte what it always was; `run()` just forwards
`options.backend` to the tool registry.

The ACP front-end captures the client's `clientCapabilities` at `initialize`
and, per prompt, injects [`createAcpBackend`](../src/acp-backend.mjs). Reads
delegate to `fs/read_text_file`, writes to `fs/write_text_file`, and
`run_command` to `terminal/create → wait_for_exit → output → release` (the
command wrapped in `/bin/sh -c`, env sent as ACP's array-of-`{name,value}`, a
timeout killing the terminal). Delegation is **per-capability** — any op the
client didn't advertise (`fs.readTextFile`, `fs.writeTextFile`, `terminal`)
falls back to the local backend, so a client that advertises nothing gets
today's fully-local behavior.

The seam is deliberately narrow. Path-jail resolution, the read size/binary
guards, `edit_file`'s uniqueness check, `run_command`'s changed-file snapshot,
and all tracking stay in the tools — the backend only owns the final read,
write, or command execution. The path jail ([`src/path-jail.mjs`](../src/path-jail.mjs))
always runs (model output is untrusted whether the write lands locally or via
the client); the backend only ever receives already-jailed absolute paths. Two
honest limits in this version: the changed-file snapshot stays local (correct
for a co-located editor sharing the working tree), and a brand-new file that
exists only in an unsaved client buffer isn't readable, since `read_file`'s
local `stat` guard runs before the delegated read.

### What stays untouched

The run loop, providers, compaction, verify, heal, review, and memory don't
change at all. ACP is a front-end and an output channel — precisely the
boundary the reporter was built to sit on. That's the payoff of having already
factored the TUI out as "just another reporter": the second remote consumer
costs a reporter, a `confirm`, and a transport, not a rewrite.

## Sketch

```
ACP client (editor)                      Kodr (agent subprocess)
      │                                          │
      │  initialize ───────────────────────────▶ │  advertise provider + tool caps
      │  session/new ──────────────────────────▶ │  run() context set up
      │  session/prompt "add validation" ──────▶ │  reporter.phase('build')
      │                                          │
      │  ◀──── session/update agent_message_chunk│  reporter.token(...)
      │  ◀──── session/update tool_call (write)  │  reporter.toolCall(...)
      │  ◀──── session/request_permission ───────│  confirm(call)  ← run_command gate
      │  ─────  { allow once } ─────────────────▶│  resolve { approved: true }
      │  ◀──── session/update tool_call_update   │  reporter.toolResult(...)
      │  ◀──── session/update plan (verify/heal) │  reporter.phase('verify')
      │                                          │
      │  ◀──── session/prompt result: end_turn   │  RunResult.stoppedReason: complete
```

## Terminology: why we don't rename Kodr's internals to match ACP

A tempting shortcut is to align Kodr's own vocabulary — reporter method
names, `stoppedReason` values, `phase` names — to ACP's public schema, on the
theory that a shared, well-known vocabulary makes the mapping trivial. It's the
wrong trade. Keep the two vocabularies separate and translate at the seam.
Reasons, roughly in order of weight:

- **It's a subset one way and a superset the other, so you can't actually
  align.** ACP has no term for `verify`, `heal`, `compaction`, `review`,
  `memory`, or the build→verify→heal→review `phase` lifecycle — the concepts
  that make Kodr a self-repairing harness rather than a generic editor agent.
  Renaming only the concepts that *do* have ACP names produces a hybrid
  vocabulary (`agent_message_chunk` next to `healTurn` and `compaction`), which
  reads worse than one consistent house vocabulary. Partial alignment is worse
  than either pure option.

- **The lossy mappings would leak into Kodr's own tooling.** `stats.mjs`
  aggregates `stoppedReason` (`complete`, `budget-exceeded`, tool-turn-limit)
  into distinct rates. ACP collapses the latter two into `max_turn_requests`.
  Adopt ACP's enum internally and you either lose that diagnostic precision or
  bolt on non-standard extensions — at which point it isn't really ACP anyway.

- **ACP names are wire names, not idiomatic JS API names.** `session/update`,
  snake_case variants like `tool_call_update` — these are JSON-RPC method and
  enum strings. AGENTS.md mandates camelCase methods, kebab-case files, and
  plain objects; `reporter.agent_message_chunk(...)` fights the house style
  everywhere it appears.

- **It inverts the dependency direction we want.** `specs/reporter.yaml` is a
  stable internal contract Kodr owns; ACP is an external contract it doesn't,
  and one still evolving. The reporter seam is deliberately an anti-corruption
  layer — ACP churn is absorbed in one adapter file, not spread across the
  codebase. Aligning internals removes exactly the isolation that seam exists
  to provide.

- **The saving is tiny and the cost is churn plus coupling.** The whole payoff
  of "map at one seam" is that the translation is a small table in `acp.mjs`.
  Renaming the codebase and its specs to delete a small table is a lot of churn
  to avoid a little — and it buys coupling to a moving external schema in return.

**Where selective alignment *is* worth it**, and the line we'd draw:

- Inside the ACP adapter and its spec, speak fluent ACP natively (StopReason,
  `session/update` variants). That's implementing the protocol correctly, not
  aligning Kodr.
- Keep the reporter→`session/update` and `stoppedReason`→`StopReason` mapping
  tables (above) as the single source of truth, reviewed in one place.
- Optionally, `--events` NDJSON — already an external event stream with no
  strong identity of its own — could borrow ACP's event names, translated in
  `createJsonReporter`, without touching the reporter method names.

Rule of thumb: keep two vocabularies, thin the boundary between them. Kodr's
domain model reflects what a self-healing harness does; ACP's reflects the
editor↔agent contract. They overlap but aren't the same shape, and the adapter
is where different shapes are meant to meet — not a reason to flatten one into
the other.

## Testing

Three layers, so each kind of failure is caught at the cheapest place that can catch it:

- **In-process unit tests** ([`test/acp-protocol.test.mjs`](../test/acp-protocol.test.mjs), [`test/acp-reporter.test.mjs`](../test/acp-reporter.test.mjs), [`test/acp.test.mjs`](../test/acp.test.mjs), [`test/acp-backend.test.mjs`](../test/acp-backend.test.mjs)) — the protocol routing, StopReason/reporter/tool-kind maps, session lifecycle, permission flow, and fs/terminal delegation logic, all against a fake connection. Fast, deterministic, no subprocess.
- **Real-stdio transport test** ([`test/acp-stdio.test.mjs`](../test/acp-stdio.test.mjs)) — spawns an actual `kodr acp` process and exercises everything up to `session/prompt` (initialize + capability capture, deterministic session ids, `-32601`/`-32700`, a stray cancel) over the real pipe. Model-free, so it runs in CI where the evals can't.
- **Live eval** ([`eval/acp.eval.mjs`](../eval/acp.eval.mjs), skip-gated on LM Studio) — drives a real model through a full session and asserts the protocol *invariants* that only hold end-to-end: a model's `write_file`/`read_file` actually delegate to the client's `fs/*`, `run_command` gates through `session/request_permission` and runs via `terminal/*`, and `session/cancel` interrupts a live generation.

The last two share one reusable ACP *client* — [`eval/support/acp-client.mjs`](../eval/support/acp-client.mjs), the client half of the protocol (the half an editor implements): spawn, JSON-RPC framing, answer the server→client requests, capture `session/update`s. Import it to write more ACP tests.

## References

- ACP overview and method reference: <https://agentclientprotocol.com>
- Kodr's reporter contract: [`src/reporter.mjs`](../src/reporter.mjs), [`specs/reporter.yaml`](../specs/reporter.yaml)
- The TUI as a reporter consumer (the pattern to mirror): [`specs/tui.yaml`](../specs/tui.yaml), [`src/tui-reporter.mjs`](../src/tui-reporter.mjs)
- The command-approval seam: `--approve-commands`, `confirm()` in [`src/tui.mjs`](../src/tui.mjs)
```
