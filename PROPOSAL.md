# Kodr 2 — Proposal

A targeted, opinionated rebuild of the Kodr coding assistant. Not a port of kodr v1 — a fresh codebase that takes the hard-won lessons from 264 phases and applies them to a narrower, sharper tool.

## What we learned from v1

Kodr v1 grew into ~29k lines across 60+ source files. The journey was the point — it was a learning tool — but it also revealed what actually matters for a local coding assistant:

**Worth keeping (ideas, not code):**
- Zero-dependency, Node.js built-ins only (kept us honest about complexity)
- Tools as first-class citizens (not bolted on at phase 11)
- The harness concept: guides (feedforward context) and sensors (feedback after the model acts)
- Safe-writes with path jailing
- Verification as a non-negotiable step
- Healing loop with no-progress detection
- Process documentation alongside code

**What hurt:**
- 3,400-line `run-pipeline.mjs` — the monolith always wins when there's no architectural boundary
- Feature creep through 264 phases: TUI, web server, subagents, MCP client, Docker sandbox, OpenShell, model routing, prompt caching — each individually reasonable, collectively a maintenance burden
- Tri-state options (`false / true / 'auto'`) that made every code path a decision tree
- JSON envelope extraction became its own subsystem (1,200 lines) because the model couldn't reliably produce structured output
- `app.mjs` was split at phase 148 — 147 phases too late

**What we're deliberately dropping:**
- TUI / interactive mode (out of scope for v2 launch)
- Web server / web channel
- Subagent orchestration
- Docker/OpenShell sandboxing
- MCP client
- OpenRouter / multi-provider routing
- Prompt caching optimisations
- Session management (continuation, compaction, browsing, export)
- Model comparison / A-B measurement


## Design principles

1. **One job, done well.** Kodr 2 is a one-shot coding harness with continuation support. It reads a prompt, assembles context, calls the model, applies the result, verifies it, and optionally heals. That's it.

2. **Tools from day one.** The model gets tools to read files, write files, run commands, and search. The tool loop is the primary execution mode — not JSON envelope extraction. If the model's tool-call support is poor, that's a model problem, not a harness problem.

3. **LM Studio only.** No provider abstraction. One base URL, one API shape (OpenAI-compatible chat completions with tool support). The `models` endpoint for discovery. That's the contract.

4. **Simple code.** No tri-state booleans. No `'auto'` mode. A function either runs or it doesn't. If a conditional has more than two branches, it's probably two functions. Flat control flow over clever indirection.

5. **Feature specs, not phase files.** Every feature is defined in a spec file before implementation begins. Specs are the contract. Tests prove the contract. This replaces the "phase file + blog post + decision log + failure log" overhead with something leaner.

6. **Eval-first development.** Integration tests that run real prompts against real models are not optional extras — they're how we know the tool works. Unit tests cover the deterministic parts. Evals cover the non-deterministic parts.


## Architecture

```
kodr2/
  bin/kodr.mjs              # CLI entry point
  src/
    cli.mjs                  # Argument parsing, dispatch
    harness.mjs              # The main loop: context → model → apply → verify → heal
    model.mjs                # LM Studio client (chat completions + tool calls + streaming)
    context.mjs              # Workspace context assembly (file map, instructions)
    tools/
      index.mjs              # Tool registry and dispatch
      read-file.mjs          # Read file contents
      write-file.mjs         # Write/create files (path-jailed)
      list-files.mjs         # List directory contents
      search.mjs             # Grep/search across files
      run-command.mjs        # Execute shell commands (allowlisted)
    apply.mjs                # Write tool results to disk (safe-writes)
    verify.mjs               # Run test/check commands, collect results
    heal.mjs                 # Bounded repair loop
    format.mjs               # Render model output, diagnostics, results for terminal
  specs/
    *.yaml                   # Feature specifications (see below)
  test/
    *.test.mjs               # Unit tests (node:test, fast, deterministic)
  eval/
    *.eval.mjs               # Integration evals (node:test, hit the model, slow)
    fixtures/                # Eval task workspaces
  AGENTS.md                  # Project rules (this project's instructions for AI agents)
```

### Module boundaries

Every module has one job and exports a small surface:

| Module | Responsibility | Imports from |
|---|---|---|
| `cli.mjs` | Parse args, call harness | `harness` |
| `harness.mjs` | Orchestrate the loop | `model`, `context`, `tools/index`, `apply`, `verify`, `heal`, `format` |
| `model.mjs` | HTTP to LM Studio | nothing internal |
| `context.mjs` | Build system prompt + file context | nothing internal |
| `tools/index.mjs` | Registry, dispatch, schema | individual tool modules |
| `tools/*.mjs` | Individual tool implementations | nothing internal |
| `apply.mjs` | Safe file writes | nothing internal |
| `verify.mjs` | Run verification commands | nothing internal |
| `heal.mjs` | Repair loop | `model`, `format` |
| `format.mjs` | Terminal output | nothing internal |

Arrows only point down or sideways. No cycles. `harness.mjs` is the only module that touches more than two siblings.


## The harness loop

The core execution is a single function:

```
run(prompt, options) → result

1. Assemble context
   - Read AGENTS.md / KODR.md from workspace
   - Build file listing (flat, not a tree — just paths)
   - Collect tool definitions

2. Call model with tools
   - System prompt + user prompt + tool definitions
   - Stream response
   - When model calls a tool: execute it, return result, continue
   - Loop until model produces a final text response (or hits turn limit)

3. Verify
   - If a test command is configured, run it
   - Collect pass/fail + output

4. Heal (if verify failed, up to N turns)
   - Feed failure output + file state back to model
   - Model calls tools to fix
   - Re-verify
   - Stop on: pass, turn limit, or no-progress (same failure twice)

5. Return result
   - Files changed, verification outcome, turn count, token usage
```

### Continuation

A run produces a conversation transcript (the messages array). Continuation feeds the prior transcript back as context for a follow-up prompt. This is not session management — it's just "here's what happened last time, now do this."

The CLI exposes this as:
```
kodr run "add error handling" --continue last
```

Where `last` reads the most recent run's transcript from `.kodr/runs/`.


## Tools

Tools are the primary way the model interacts with the codebase. Every tool is a plain object with three fields:

```javascript
export default {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' }
      },
      required: ['path']
    }
  },

  execute: async ({ path }, context) => {
    // context.cwd, context.allow(path), etc.
    // Returns { content: string } or { error: string }
  }
}
```

The registry collects these, generates the `tools` array for the API call, and dispatches calls by name. No class hierarchy, no plugin system, no dynamic loading.

### Initial tool set

| Tool | Purpose |
|---|---|
| `read_file` | Read a file's contents |
| `write_file` | Create or overwrite a file (path-jailed to workspace) |
| `edit_file` | Apply a targeted edit to an existing file (search/replace) |
| `list_files` | List files in a directory (with glob support) |
| `search` | Grep across the workspace |
| `run_command` | Execute a shell command (configurable allowlist) |

This is deliberately minimal. More tools (e.g., `git_diff`, `run_tests`) can be added later via specs.


## Feature specs

Every feature is defined in a YAML file under `specs/`. A spec is a simplified, flat contract — inspired by OpenAPI but without the ceremony.

```yaml
# specs/tool-read-file.yaml
name: read_file tool
status: proposed  # proposed | accepted | implemented | deprecated
description: >
  Read the contents of a file relative to the workspace root.
  Path-jailed: cannot read above the workspace directory.
  Returns file contents as a string, or an error if the file
  doesn't exist or is binary.

inputs:
  path:
    type: string
    required: true
    description: Relative path from workspace root

outputs:
  content:
    type: string
    description: File contents (UTF-8)
  error:
    type: string
    description: Error message if read failed

constraints:
  - Path must resolve within workspace root (no ../ escape)
  - Binary files return an error, not garbled content
  - Maximum file size 1MB (return error above this)
  - Symlinks are resolved before jail check

tests:
  unit:
    - reads a text file and returns contents
    - rejects paths that escape workspace root
    - rejects binary files
    - rejects files over 1MB
    - resolves symlinks before jail check
  eval:
    - model asked to read a specific file gets correct contents
```

### Why YAML, not markdown

Markdown specs drift into prose. YAML forces structure: what goes in, what comes out, what the constraints are, what the tests prove. It's parseable — we can generate test skeletons and check spec coverage programmatically.

### Spec lifecycle

```
proposed → accepted → implemented → (deprecated)
```

A spec starts as `proposed` when someone writes it. It moves to `accepted` when both the interface and the test plan are agreed. It moves to `implemented` when the code exists and all listed tests pass. We can write a simple `kodr specs` command that reports coverage.


## Testing strategy

### Unit tests (`test/*.test.mjs`)

Fast, deterministic, no network. Test the mechanical parts:
- Path jailing logic
- Tool dispatch
- Context assembly
- Argument parsing
- Output formatting
- Safe-writes

Run with: `node --test test/`

### Eval tests (`eval/*.eval.mjs`)

Hit the real model via LM Studio. Slow (seconds to minutes per case). Test the non-deterministic parts:
- "Given this task and this workspace, does the model produce working code?"
- "Does the tool loop terminate?"
- "Does healing actually fix the failure?"

Each eval is a `node:test` file that:
1. Sets up a fixture workspace (temp directory with known files)
2. Calls `harness.run()` with a prompt
3. Asserts on the outcome (files changed, verification passed, specific content present)

Evals are tagged so you can run subsets:
```
node --test eval/ --test-name-pattern "tool-loop"
```

Evals are expected to be flaky (model non-determinism). We track pass rates over time, not binary pass/fail. A test that passes 8/10 times is useful information. A test that passes 10/10 on one model and 3/10 on another is even more useful.

### What we don't test

We don't mock the model. If a test needs the model, it's an eval and it hits LM Studio. If a test doesn't need the model, it's a unit test and it uses no network. There is no middle ground with fake model responses — that's testing your mocks, not your system.

Exception: we do record model responses in eval runs for debugging. But we never replay them as assertions.


## Coding standards

- Node.js 24, ESM, zero runtime dependencies
- Biome for formatting (globally installed, not a dev dependency)
- No TypeScript (keep the feedback loop fast; JSDoc where types help readability)
- No classes unless the abstraction genuinely needs instance state
- Functions return plain objects, not class instances
- Errors are returned values (`{ error: 'message' }`), not thrown exceptions, at module boundaries. Internal helpers can throw.
- No `async/await` chains longer than 3 levels deep — extract a function
- No ternaries in branch logic — use `if/else`
- No `'auto'` tri-states — boolean flags only
- File names are kebab-case: `read-file.mjs`, not `readFile.mjs`


## What ships first

The absolute minimum to be useful:

1. **Model client** — connect to LM Studio, send chat completions with tools, stream responses
2. **Tool registry + read_file + write_file + list_files** — model can explore and modify a codebase
3. **Harness loop** — prompt → tool loop → final response
4. **CLI** — `kodr run "do the thing"`
5. **One eval** — prove the loop works end-to-end against a real model

That's the walking skeleton. Everything else (search, edit_file, run_command, verify, heal, continuation) layers on top.


## What this is not

- Not a chat interface. One prompt in, one result out (with tool calls in between).
- Not a multi-model router. LM Studio, one model at a time.
- Not a general plugin platform. There are extension points (see "Extension model" below), but nothing is dynamically loaded — every extension lives in the source tree and is reviewed. We don't run arbitrary third-party plugin code.
- Not an agent framework. No subagents, no orchestration, no delegation.
- Not a product. It's a development tool for us, built in public.


## Extension model (added since this proposal)

The original proposal framed extensibility as "tools, in the source tree." As the
tool grew, that expanded into four distinct extension points. They differ along two
axes — *who triggers them* and *whether they feed back into the conversation* — and
that difference is the whole point: reaching for the wrong one is a design smell.
All four are in-tree and config-gated; none is dynamically loaded.

| Extension | Triggered by | Feeds back to the model? | Config |
|---|---|---|---|
| **Tools** | the model | yes (tool result) | in-tree registry (`src/tools/index.mjs`) |
| **Skills** | the model | yes (instructions injected) | `.kodr/skills/*/SKILL.md`, loaded via `load_skill` |
| **Hooks** | the operator | yes, when blocking | `.kodr/hooks.json` |
| **Plugins** | the harness | no (observers only) | `.kodr/plugins.json` / `--plugin` |

- **Tools** and **skills** are model-invoked and feed results back into the
  conversation — the model calls a tool, or loads a skill's instructions, mid-run.
- **Hooks** (`specs/hooks.yaml`, implemented) are the deterministic,
  operator-controlled counterpart to tool calls: user shell commands bound to
  lifecycle events (`Stop`, `PreToolUse`, `PostToolUse`, `SessionStart`,
  `SessionEnd`). A blocking hook's output feeds back through the heal loop.
- **Plugins** (`specs/plugins.yaml`) are host-driven observers — output sinks that
  ride the one-way reporter channel (`specs/reporter.yaml`). A plugin's `setup()`
  returns a reporter and the harness fans the run's reporter out to it, so the
  plugin sees each turn, tool call, and the final summary. The model never sees a
  plugin and a plugin writes nothing back into the conversation. Plugins are off by
  default and enabled per workspace/run. The first plugin is **Telegram**
  (`specs/plugin-telegram.yaml`), which mirrors a run's turns to a Telegram channel
  using built-in `fetch`, credentials from the environment only.

The boundary from "What this is not" still holds: these are in-tree and reviewed.
There is no dynamic loading of arbitrary third-party plugin code.


## Relationship to v1

Kodr 2 is not a fork or refactor of v1. It's a clean-room rebuild informed by v1's experience. Specific things carried forward as knowledge, not code:

- The harness loop shape (context → model → apply → verify → heal)
- Safe-writes path jailing approach
- Tool definition shape (OpenAI function calling schema)
- No-progress detection in healing (same failure = stop)
- The principle that model output is untrusted
- The principle that examples must be generated by the tool itself, never by a frontier model

We may extract ideas from v1's `process/decisions.jsonl` and `process/failures.jsonl` as we hit similar problems. But we write new code.


## Open questions

1. **Streaming UX.** v1 eventually supported streaming. For v2's one-shot mode, do we stream tool calls to the terminal in real time, or batch and show a summary? Leaning toward streaming with a compact format (one line per tool call).

2. **Workspace instructions file name.** v1 used `AGENTS.md` then `KODR_MEMORY.md`. Convention is shifting toward `.kodr/` directories. Proposal: read `KODR.md` at workspace root if it exists; ignore everything else.

3. **run_command allowlist.** v1 had an explicit allowlist for verification commands. For v2, should `run_command` be open (model can run anything) with a confirmation prompt, or closed (allowlist only)? Leaning toward open-with-confirmation since tools-first means the model needs `run_command` for tasks like "run the tests", "install deps", etc.

4. **Eval infrastructure.** How do we track eval pass rates over time? v1 built a trends dashboard. For v2, start with a JSONL log and defer visualisation.
