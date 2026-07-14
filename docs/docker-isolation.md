# Running Kodr isolated (the sandbox box)

Kodr's `run_command` tool runs whatever shell the model writes, and only `cd`
targets are jailed — absolute paths and redirects are not (see
[`specs/tool-run-command.yaml`](../specs/tool-run-command.yaml)). That is fine
when you trust the model and the task, but while **testing Kodr locally** a bad
turn can touch anything on your disk.

`scripts/kodr-box.sh` caps that blast radius by running your **local Kodr
checkout** inside a container:

- your current directory is mounted read-write at `/workspace` — the **only**
  writable host path, so file edits and `run_command` output can't escape it;
- the Kodr checkout is mounted **read-only** at `/opt/kodr`, so your Kodr
  source edits take effect with **no rebuild** (Kodr is zero-dependency, so it
  runs straight from the mount);
- outbound network is **restricted to your host's LLM** by default; the model
  is reached over its API from inside the box.

It's a local testing aid — nothing is pushed to a registry.

## Requirements

- Docker (Desktop on macOS/Windows, or Engine on Linux).
- A model server. By default the box reaches a **host-run** LM Studio or
  Ollama. That server must listen on `0.0.0.0`, not just loopback, or the
  container can't reach it:
  - **LM Studio**: enable *Serve on Local Network* in the server settings.
  - **Ollama**: run with `OLLAMA_HOST=0.0.0.0`.

## Quick start

```bash
cd /path/to/your/repo          # this becomes the workspace
/path/to/kodr2/scripts/kodr-box.sh run "add input validation to server.mjs"
```

The first run builds the image (`kodr-box`); later runs reuse it. With no
arguments you get Kodr's interactive TUI. Everything after the wrapper's own
`--box-*` flags is forwarded verbatim to `kodr`, so all the usual flags work:

```bash
kodr-box.sh run "refactor the auth module" --test "npm test" --max-tool-turns 40
```

Files the run creates in your repo are owned by **you** (the box drops from
root to your UID/GID before running Kodr), and `kodr` saves its transcript to
`/workspace/.kodr/runs` — pass `--no-save` if you want the tree untouched.

## Providers

The wrapper injects `--base-url` so local providers reach the host, unless you
pass your own `--base-url`:

| provider | reached at | notes |
|---|---|---|
| `lmstudio` (default) | `host.docker.internal:1234` | no key |
| `ollama` | `host.docker.internal:11434` | set `OLLAMA_API_KEY` for hosted |
| `openrouter` | `openrouter.ai` directly | needs `OPENROUTER_API_KEY` **and** `KODR_BOX_NETWORK=open` (see below) |

Forwarded host env vars (only those actually set) default to
`OPENROUTER_API_KEY,OLLAMA_API_KEY,KODR_PROVIDER,KODR_MODEL,KODR_REASONING,KODR_NO_SAVE`.
Secrets are passed by name, so they never appear in a dry-run printout.

## Network posture

`KODR_BOX_NETWORK` controls egress:

- **`locked`** (default) — the container programs an iptables allowlist and can
  reach **only** the host LLM port(s). Nothing else on the internet is
  reachable. This also blocks the model's own `npm install` / `pip` /
  `git fetch` — by design. Requires `--cap-add=NET_ADMIN`, which the wrapper
  adds automatically; on rootless Docker it may be refused, so use `open`.
- **`open`** — standard outbound. Needed for `openrouter` and for tasks whose
  build/test steps fetch from the network.

```bash
KODR_BOX_NETWORK=open kodr-box.sh run "…" --provider openrouter --model qwen/qwen3.6-35b-a3b
```

## Wrapper flags and config

Flags (stripped before forwarding to `kodr`):

- `--box-build` — rebuild the image even if it exists (after editing the
  `Dockerfile`; **not** needed for Kodr source changes).
- `--box-dry-run` — print the assembled `docker` command and run nothing.
- `--box-shell` — open a shell inside the sandbox (same mounts and egress
  lock) instead of running Kodr, for debugging.

Config via environment (all overridable):

| var | default | meaning |
|---|---|---|
| `KODR_BOX_IMAGE` | `kodr-box` | image tag |
| `KODR_BOX_NETWORK` | `locked` | `locked` \| `open` |
| `KODR_BOX_HOST` | `host.docker.internal` | host alias for the LLM |
| `KODR_BOX_LMSTUDIO_PORT` | `1234` | host LM Studio port |
| `KODR_BOX_OLLAMA_PORT` | `11434` | host Ollama port |
| `KODR_BOX_HOME` | `/tmp` | writable HOME in the container |
| `KODR_BOX_WORKSPACE` | `/workspace` | workspace mount point |
| `KODR_BOX_ENV_PASS` | see above | host env names to forward |

## Extending the toolchain

The image is batteries-included (Node 22, git, python3, build tools, `jq`,
`ripgrep`, `curl`). Add more at build time and rebuild:

```bash
docker build -t kodr-box --build-arg EXTRA_APT="golang-go openjdk-17-jdk-headless" \
  -f /path/to/kodr2/Dockerfile /path/to/kodr2
```

## How it works (verify it yourself)

```bash
# See exactly what would run — no Docker needed
kodr-box.sh --box-dry-run run "hello"

# Prove the filesystem boundary: edit a file in the workspace, confirm the
# host outside your repo is untouched. Then prove egress is locked:
KODR_BOX_NETWORK=locked kodr-box.sh --box-shell
#   curl -m3 https://example.com   → fails
#   curl -m3 http://host.docker.internal:1234/v1/models → succeeds
```

The contract is [`specs/docker-isolation.yaml`](../specs/docker-isolation.yaml);
the Docker-free tests are in `test/docker-isolation.test.mjs`. This generalizes
the container recipe first sketched in
[`examples/terminal-bench.md`](../examples/terminal-bench.md).
