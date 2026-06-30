# Running Kodr under Terminal-Bench (or any harness arena)

[Terminal-Bench](https://www.tbench.ai/) is a harness arena: its leaderboard is
*agents/scaffolds* (OpenHands, Codex CLI, Aider, custom), each paired with a
model, run against terminal tasks in a Docker container. This guide is the
contract for plugging Kodr in as one of those agents — with a **local** model,
matching Kodr's thesis.

It mirrors the approach used by `yakshav-terminal-bench` (a Harbor adapter that
mounts a harness binary and shells out one-shot), adapted for Kodr being a
zero-dependency Node program rather than a static binary.

## The headless contract

Terminal-Bench drives an agent by running one command inside the task container,
then runs its own verifier against the workspace. Kodr's one-shot CLI is already
that shape. The canonical invocation:

```bash
kodr run "<task instruction>" \
  --cwd /app \
  --base-url http://host.docker.internal:1234/v1 \
  --model "<model>" \
  --max-run-ms 1800000 \
  --no-save \
  --json
```

Why each flag:

| flag | why |
|---|---|
| `--cwd /app` | task root in Terminal-Bench containers. Use `--cwd /` for system-configuration tasks that write outside `/app` (see sandbox note) |
| `--base-url http://host.docker.internal:1234/v1` | reach the **host's** model server (LM Studio, or Ollama's OpenAI endpoint at `:11434/v1`) from inside the container |
| `--model` | Harbor passes `provider/model`; the adapter forwards the model id |
| `--max-run-ms` | map the task's agent timeout |
| `--no-save` | don't write `.kodr/runs` into the task workspace — keeps it clean so byte-exact verifiers aren't tripped (or use `--runs-dir <outside>`) |
| `--json` | print a machine-readable run summary to stdout so the adapter can record cost/outcome |
| **no `--test`** | the task's own verifier is the source of truth; Kodr should not self-verify |

`--json` prints one line such as:

```json
{"stoppedReason":"complete","completed":true,"toolTurns":7,"usage":{"prompt":12736,"completion":965},"compactions":0,"healed":null,"healTurns":null,"verified":null,"filesChanged":["server.js"],"packageCommands":[],"response":"...","error":null}
```

`--json` implies `--quiet`, so stdout is *only* that line — safe for an adapter
to parse (this is what YakShav's `populate_context_post_run` lacked).

## Why Kodr is already container-ready

- **Sandbox root.** File tools are jailed to `realpath(--cwd)`; the shell tool is
  unrestricted (only `cd` targets are jailed). `--cwd /app` scopes file edits to
  the task; `--cwd /` widens the jail to the whole filesystem for system tasks —
  the equivalent of YakShav's `YAKSHAV_WORKING_DIR=/`.
- **Local, no auth.** Kodr talks plain OpenAI-compatible HTTP with no API-key
  handling, by design. Point `--base-url` at LM Studio or Ollama on the host.
  (Hosted, authenticated providers are intentionally out of scope.)
- **Graceful probe.** Kodr probes LM Studio's `/api/v0/models` for the loaded
  context window; against a non-LM-Studio server that 404s, it falls back to the
  default window instead of failing. So Ollama works.
- **Clean artifacts.** `--no-save` (or `--runs-dir`) keeps run transcripts out of
  the task workspace.

## Adapter sketch (Harbor)

Kodr isn't a single binary, so `install()` ensures Node and makes Kodr
available, then `run()` shells out — the rest mirrors `yakshav_agent.py`:

```python
class KodrAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "kodr"

    async def install(self, env):
        # zero-dependency: Node + the Kodr source is all that's needed
        await self.exec_as_root(env, command=(
            "apt-get update -qq && DEBIAN_FRONTEND=noninteractive "
            "apt-get install -y nodejs npm git && "
            # pre-mounted at /opt/kodr via --mounts-json, or: npm i -g kodr
            "node /opt/kodr/bin/kodr.mjs --version"
        ))

    @with_prompt_template
    async def run(self, instruction, env, context):
        provider, model = self._split_model(self.model_name)  # e.g. ollama/qwen3
        base = ("http://host.docker.internal:11434/v1" if provider == "ollama"
                else "http://host.docker.internal:1234/v1")
        working_dir = self._get_env("KODR_WORKING_DIR") or "/app"
        cmd = (
            f"node /opt/kodr/bin/kodr.mjs run {shlex.quote(instruction)} "
            f"--cwd {working_dir} --base-url {base} --model {shlex.quote(model)} "
            f"--max-run-ms 1800000 --no-save --json"
        )
        result = await self.exec_as_agent(env, command=cmd, timeout_sec=1800)
        # the last stdout line is the --json summary — record turns/tokens
        context.metadata["kodr"] = parse_last_json_line(result.stdout)
```

Mount Kodr's `bin/` + `src/` read-only (zero-dep, so no `node_modules` needed):

```
--mounts-json '[{"type":"bind","source":"<repo>","target":"/opt/kodr","read_only":true}]'
```

## The shared task schema

The internal harness arena (`eval/arena/`) uses a harness-agnostic task schema
(prompt, setup, verify, budget). The same task files can feed both the internal
arena (fixed local model, ablate Kodr) and a Terminal-Bench-style cross-harness
run (fixed model, Kodr vs other harnesses) — so the two evaluation paths stay in
sync.
