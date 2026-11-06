# Running Kodr in an OpenShell sandbox

`run_command` runs whatever shell the model writes, and only `cd` targets are
jailed — absolute paths and redirects are not (see
[`specs/tool-run-command.yaml`](../specs/tool-run-command.yaml)). Nothing
constrains outbound network at all. That is fine when you trust the model and
the task, but for an **unattended** run, or one with a real API key in the
environment, the blast radius is your whole user account.

[`scripts/kodr-shell.sh`](../scripts/kodr-shell.sh) runs your local Kodr
checkout inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
sandbox, where the kernel does the confining:

- **Filesystem** — Landlock. Only the workspace and `/tmp` are writable;
  `/usr`, `/etc`, `/var/tmp` and the rest are denied, and no `chmod` lifts it.
- **Network** — default-deny, with one rule allowing **the node binary only**
  to reach your model server. This is the reason to reach for OpenShell rather
  than a container with an iptables port allowlist: iptables cannot tell
  `node` reaching `:1234` from a model-issued `curl` reaching the same port.
  OpenShell can, because it matches rules against the calling binary.
- **Credentials** — an OpenShell provider record keeps the key outside the
  sandbox entirely; the supervisor injects it only into approved requests.

Kodr is a good fit for this because it has **zero runtime dependencies**: the
checkout is uploaded and run straight from the mount, with no `npm install`,
so the sandbox needs no registry egress at all.

This is an external wrapper, not a Kodr feature — nothing under `src/` knows
it is sandboxed.

## Requirements

- [OpenShell](https://github.com/NVIDIA/OpenShell) with a running gateway
  (`openshell status` should say Connected). Verified against **0.1.7**; the
  CLI is pre-1.0 and its flags move.
- Docker, for the sandbox image.
- A model server. By default the sandbox reaches a **host-run** LM Studio or
  Ollama through the alias `host.openshell.internal`.

On Docker Desktop for Mac a loopback-only model server works, because Desktop
proxies that alias to host loopback. On Linux Docker, or another compute
driver, you will likely need the server listening beyond loopback — LM
Studio's *Serve on Local Network*, or `OLLAMA_HOST=0.0.0.0` for Ollama.

## Quick start

Build the image once:

```bash
KODR_SHELL_BUILD=1 scripts/kodr-shell.sh --version
```

Then run from the directory you want as the workspace:

```bash
cd /path/to/your/repo && /path/to/kodr2/scripts/kodr-shell.sh run "add input validation"
```

Everything after the script name is forwarded to `kodr`, so the usual flags
work. `--base-url` and `--cwd` are injected only if you do not pass them.

To see exactly what it would do without running anything:

```bash
KODR_SHELL_DRYRUN=1 scripts/kodr-shell.sh loop --test "npm test"
```

## Unattended loops, and getting the work back

`kodr loop` is the case this is built for (see [the backlog
guide](loop.md)). The workspace is **uploaded**, so edits and commits live in
the sandbox until you pull them back — and the sandbox is deleted when the run
ends unless you say otherwise. A run whose results you never download is lost.

```bash
KODR_SHELL_KEEP=1 KODR_SHELL_DOWNLOAD=1 scripts/kodr-shell.sh loop --test "npm test" --max-attempts 2
```

The workspace is returned to `<workspace>.returned` beside the original rather
than over it, with git history intact. `KODR_SHELL_DOWNLOAD=1` without
`KODR_SHELL_KEEP=1` is refused, because the sandbox would be gone first.

Git identity is passed as environment (`GIT_AUTHOR_*`/`GIT_COMMITTER_*`),
which the shell runner's allowlist forwards (see
[`specs/tool-run-command.yaml`](../specs/tool-run-command.yaml)). The sandbox
has no `~/.gitconfig`, so without that the loop would do all its work and then
fail on its first commit with "Author identity unknown".

## Configuration

Everything is overridable by environment variable.

| Variable | Default | Purpose |
|---|---|---|
| `KODR_SHELL_DRYRUN` | `0` | Print the policy and commands, run nothing |
| `KODR_SHELL_SANDBOX` | `kodr-shell-$$` | Sandbox name |
| `KODR_SHELL_WORKSPACE` | `$PWD` | Host directory uploaded as the workspace |
| `KODR_SHELL_SRC` | the repo | Kodr checkout to upload |
| `KODR_SHELL_IMAGE` | `kodr-shell:latest` | Image tag |
| `KODR_SHELL_BUILD` | `0` | `1` builds `docker/openshell/` into that tag first |
| `KODR_SHELL_HOST` | `host.openshell.internal` | Alias for the host model server |
| `KODR_SHELL_LMSTUDIO_PORT` | `1234` | LM Studio port |
| `KODR_SHELL_OLLAMA_PORT` | `11434` | Ollama port |
| `KODR_SHELL_NODE` | `/usr/local/bin/node` | Node path inside the sandbox, used as the egress rule's binary scope |
| `KODR_SHELL_NETWORK` | `locked` | `open` also allows the provider's public host |
| `KODR_SHELL_PROVIDER_RECORD` | — | OpenShell provider to attach for credential injection |
| `KODR_SHELL_KEEP` | `0` | `1` leaves the sandbox running |
| `KODR_SHELL_DOWNLOAD` | `0` | `1` returns the workspace (needs `KEEP=1`) |
| `KODR_SHELL_POLICY` | — | Use this policy file instead of the generated one |
| `KODR_SHELL_KEEPALIVE` | `14400` | Seconds the sandbox is held open |
| `KODR_SHELL_READY_TIMEOUT` | `120` | Seconds to wait for `Ready` |
| `KODR_SHELL_OPENSHELL` | `openshell` | Path to the CLI |

The policy is **generated**, not shipped as a fixture, so it cannot disagree
with the base URL: overriding the host or port has to move the allowed
endpoint too. `KODR_SHELL_POLICY` overrides it with a file of your own.

## Providers

| Provider | Reached at | Notes |
|---|---|---|
| `lmstudio` (default) | `host.openshell.internal:1234` | no key |
| `ollama` | `host.openshell.internal:11434` | set a provider record for hosted |
| `openrouter` | `openrouter.ai` directly | needs `KODR_SHELL_NETWORK=open` and a provider record |

## Gotchas

- **The sandbox is deleted on exit** unless `KODR_SHELL_KEEP=1`, and that
  takes the workspace with it.
- **`openrouter` gets no base-url injection and no host rule.** Without
  `KODR_SHELL_NETWORK=open` it has no egress and the run will fail.
- **A wrong `KODR_SHELL_NODE` denies everything.** The rule is scoped to that
  exact path; naming one that does not exist in the image produces an egress
  failure that reads like a bad base URL. The official node images put it at
  `/usr/local/bin/node`, not `/usr/bin/node`.
- **Denials are not consistent across OpenShell versions.** On 0.0.x egress
  was an HTTP proxy and a denial was a `403` with a `policy_denied` body; on
  0.1.7 a denied binary gets a plain connection failure. Treat any
  non-success as denied and read the gateway log for the reason.
- **An unexplained denial may be IPv6.** The host alias resolves to both
  families inside the sandbox. Check `getent ahosts host.openshell.internal`
  before blaming the base URL.
- **Expect harmless noise** on every exec — a `.profile: Permission denied`
  from bash when the policy denies the home directory, and an `[UNDICI-EHPA]`
  warning from node. Neither affects the run.
- **On macOS the sandbox runs inside a Linux VM**, so Landlock and seccomp
  apply there rather than to the host OS. The boundary is real; it is one
  level further out than on Linux.
