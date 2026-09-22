# Run management

[Everyday usage](usage.md) · [Providers](providers.md)

- [Context and compaction](#context-and-compaction)
- [Timeouts and budgets](#timeouts-and-budgets)
- [Saved runs and diagnostics](#saved-runs-and-diagnostics)
- [Memory](#memory)

## Context and compaction

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

## Timeouts and budgets

For slow shell commands issued by the model:

```bash
kodr "run the build and fix any errors" --command-timeout-ms 1200000
```

The default is 600000 ms (10 minutes). Set `KODR_COMMAND_TIMEOUT_MS` for a
shell-wide default; the explicit flag wins. This applies to `run_command`,
not the `--test` verification command. Verification uses Stop-hook timeouts;
see the [hook configuration](../specs/hooks.yaml).

`--request-timeout-ms` / `KODR_REQUEST_TIMEOUT_MS` separately controls each
model HTTP request (default 600000 ms). `--max-run-ms` controls the run's
wall-clock budget, checked between turns (default 0, disabled).

Another budget on a long session is the **tool-turn ceiling**
(`--max-tool-turns`, default 50). Note how it compounds with the system
prompt: the prompt tells the model to make *one tool call per message*
(deliberately — many small local models mangle parallel calls), so the
ceiling is effectively a budget of ~50 tool invocations per run. A
read → edit → test cycle eats that quickly. If a task keeps stopping with
`tool-limit`, raise the ceiling; the serialization itself is prompt-imposed,
not a harness limit — the loop executes every native call in a message.

On a hosted provider there's a third budget worth setting, in dollars:

```bash
kodr "…" --provider openrouter --model your-model-id --max-cost-usd 0.50
```

Replace `your-model-id` with an available model. The cost ceiling can also be
set through `KODR_MAX_COST_USD`. It's off by default. When set, the run stops
between turns as soon as its
accumulated cost reaches the ceiling (`stoppedReason: cost-exceeded`), and it
covers the whole run — the build loop, heal, the review pass, the memory
retrospective, and a `kodr goal` judge all count against the same number
rather than each getting a fresh allowance. A review or retrospective skipped
this way is recorded as a *skip*, never a failed review.

Two caveats. It's only as good as the cost the provider reports: LM Studio and
Ollama report none, so the flag is inert there. And it can only stop the run
*between* turns — the request already in flight still finishes and still gets
billed. Treat it as a bound on one runaway run, not as your only cap; set a
spending limit on the provider account too.

## Saved runs and diagnostics

Use `kodr doctor` before a run to check the provider, model, git, and Node.
Use `kodr stats` afterward to aggregate verification, repair, retry, and
review rates across saved runs.

```bash
kodr stats
kodr replay last
```

Replay runs the saved prompt again against the current workspace; it can edit
files and execute commands. It starts a fresh conversation, using recorded
settings, and does not restore an earlier version of the workspace.
Use `--continue last` to extend the conversation instead.

### Debug logs

When a model response comes back malformed, `--debug` (or `KODR_DEBUG`)
writes every request's raw request/response text to a `<timestamp>-debug.jsonl`
sidecar next to the run transcript in `.kodr/runs/` — one line per HTTP
attempt. Off by default; reach for it when the message and token counts alone
don't explain what went wrong.

### Files and locations

Kodr uses these locations in the workspace:

- `.kodr/runs/` — one JSON transcript per run (plus any `--debug` sidecar);
  what `--continue`, `replay`, and `stats` read. Change the location with
  `--runs-dir` / `KODR_RUNS_DIR`, or skip saving with `--no-save`. Add `.kodr/`
  to your `.gitignore` — it's diagnostic output, not source. (The loop scripts
  do this for you, repo-locally.)
- `.kodr/hooks.json` — SessionStart/Stop/tool hooks (see
  [`specs/hooks.yaml`](../specs/hooks.yaml)).
- `.kodr/skills/<name>/SKILL.md` — workspace skills the model can load on
  demand (see [`specs/skills.yaml`](../specs/skills.yaml)).
- `KODR.md` / `AGENTS.md` — your workspace instructions, read into the system
  prompt.
- `MEMORY.md` — durable lessons; normally applied after confirmation, or
  automatically when you explicitly enable `--memory-auto-apply`.

Debug logs and transcripts can include source code, command output, and other
sensitive context. Inspect them before sharing.

## Memory

At the end of a run, propose durable lessons for future runs in this
workspace. By default, an attended terminal asks for confirmation before writing to
`MEMORY.md`; otherwise a proposal file is written next to the transcript.
`--memory-auto-apply` explicitly opts into applying proposals without prompting.

```bash
kodr "…" --memory
kodr "…" --memory --memory-auto-apply   # trust the loop; skip the prompt
```

Applying a proposal always **appends**, so after enough runs `MEMORY.md` is
a log, not a memory: dated entries accrete, older ones contradict newer
ones, and every contradiction is loaded into every prompt — small models
follow whichever instruction they read last. `kodr consolidate` is the
other half of the design:

```bash
kodr consolidate            # propose a rewrite; y/N before anything changes
kodr consolidate --apply    # skip the prompt (prior content is backed up)
```

The model is instructed to merge duplicate lessons, prefer later entries when
they contradict earlier ones, and strip session narrative while preserving
the lessons. Review the proposal before applying it. Attended you get a `y/N`
prompt; unattended a proposal
file lands in `.kodr/runs/` and `MEMORY.md` is untouched. On apply the
prior content is backed up next to the transcripts first, and the apply
aborts safely if a concurrent run appended to the file mid-consolidation.
