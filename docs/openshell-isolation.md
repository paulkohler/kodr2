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

## Long unattended runs

A multi-hour `kodr loop` in a sandbox needs more care than a short one. What
follows comes from three attempts at the fifteen-phase CRM plan, written up in
the [post-mortem](openshell-crm-postmortem.md).

### Size the limits from your model's speed

The defaults suit a fast model. A 27B model on a laptop generated about 11
tokens per second end to end, so one response of 15,000 to 20,000 tokens, a
model writing several large files in a single turn, takes 20 to 30 minutes.

- `--request-timeout-ms` must cover your **longest single response**. When it
  fires, the response in flight is discarded whole, tool calls and all.
- `--max-run-ms` is the budget for a whole attempt, many responses. Keep the
  request timeout to **about a third of it or less**. A 20 minute request
  ceiling inside a 30 minute attempt budget let one response use two thirds of
  the attempt, and seven of twelve attempts were lost that way.
- Tell the two apart in the log: `Request timed out after 1200000ms` is the
  first, `stopped after run budget` the second. The first is retried after a
  back-off, the second at once.
- A lost attempt costs time, not work: the retry resumes the previous
  conversation with its files still on disk. It does use up one of the task's
  attempts, so a phase that loses its first attempt to the clock has one fewer
  for a genuinely red build.
- `GOAL:` items need the most headroom: a build budget per attempt, plus a
  judge call, up to four deep.

Something like `--request-timeout-ms 3600000 --max-run-ms 5400000` would be
the next thing to try for a model of that size. That pairing has **not been run**;
the one that was (20 and 30 minutes) is the cautionary example.

`KODR_SHELL_KEEPALIVE` also has to outlast the run. The default is four hours,
and a run that outlives it loses its sandbox and everything not downloaded.
The CRM runs used `172800` (48 hours).

### Launch it detached

A foreground shell is culled long before six hours. Use `nohup` and `disown`,
and redirect both streams:

```bash
nohup env KODR_SHELL_SANDBOX=crm KODR_SHELL_WORKSPACE=/path/to/crm \
  KODR_SHELL_KEEP=1 KODR_SHELL_DOWNLOAD=1 KODR_SHELL_KEEPALIVE=172800 \
  scripts/kodr-shell.sh loop --test "npm test" --reset-paths data \
  > crm.log 2>&1 < /dev/null & disown
```

### Watching it, and where the files are

The workspace lives **in the sandbox**. The directory you launched from stays
exactly as it was uploaded, and `<workspace>.returned` does not exist until the
run ends. To look mid-run:

```bash
openshell sandbox exec -n NAME --no-tty -- git -C /sandbox/WORKSPACE log --oneline
openshell sandbox download NAME /sandbox/WORKSPACE ./snapshot
```

A download reads without disturbing the run. Take one before a phase you expect
to park, because the park rewinds the tree and deletes untracked files.

The loop prints a marker per task and per attempt (see [Watching it
run](loop.md#watching-it-run)). They are `notice` lines with ANSI colour, so a
filter anchored on `^kodr loop:` or on the literal text `verify: pass` matches
nothing. Match the text after the escape, and be careful with bare words: a
filter on `verify` also matches the model's own streamed prose.

### Stopping it

Signal the kodr process **inside the sandbox**; the wrapper then carries on
and downloads the workspace as usual. Find the pid first:

```bash
openshell sandbox exec -n NAME --no-tty -- sh -c 'ps -eo pid,args | grep "[k]odr.mjs"'
openshell sandbox exec -n NAME --no-tty -- kill -TERM PID
```

`SIGTERM` worked: the loop ended, the download ran and history came back
intact. Kodr has no `SIGTERM` handler, though, so the loop record is left
without a `reason` and without the task in flight (BACKLOG #16). `SIGINT` is
the path kodr documents ([`specs/cancel.yaml`](../specs/cancel.yaml)) and
should be preferred; it was **not tried** against a sandboxed loop. Whether
killing only the local wrapper stops the process in the sandbox was also not
tested, so do not assume it does.

### Carrying on past a park

`kodr loop` stops on the first park by default, and that is right for a plan
whose phases build on each other. `--no-stop-on-park` is for when you want to
reach later phases regardless, for instance to exercise the `GOAL:` ones. The
cost is that everything after a park builds on a foundation that was just
rewound, so a later phase that depends on the parked one proves little about
the model. Read the park reasons, not the green and parked tally.

### What has not been run in a sandbox

- `kodr goal`'s **judge**: the one `GOAL:` phase reached parked before any
  build finished inside its budget.
- The heal loop.
- `kodr tui`. An interactive terminal program has nowhere to go in an
  unattended sandboxed run, and it was not attempted.

## Other languages need their own image

`docker/openshell/Dockerfile` is **node-only** — node, `procps`, `git` and
`curl`. It carries no other toolchain on purpose.

This matters more than it sounds, because **egress is default-deny and scoped
to the node binary**: the sandbox cannot `rustup`, `apt-get` or `pip` its way
to a compiler at run time. A toolchain has to be baked into an image on the
host, where Docker has network, and passed in:

```bash
KODR_SHELL_BUILD=1 KODR_SHELL_IMAGE=kodr-rust:local KODR_SHELL_IMAGE_DIR=./my-image scripts/kodr-shell.sh run "..."
```

Layer on the node base rather than starting over, and keep two things the
harness needs: **`procps`** (`shell.mjs` shells out to `ps`) and **node at the
path `KODR_SHELL_NODE` names** — the egress rule is scoped to that exact path,
so a node somewhere else means no egress at all.

```dockerfile
FROM node:24.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends       procps git curl ca-certificates rustc cargo build-essential  && rm -rf /var/lib/apt/lists/*
```

Prefer one image per language over a single fat multi-language one: the Rust
image above is ~1.4GB against ~490MB for the node base, and a sandbox pulls
the whole thing.

### Environment variables

An image `ENV` line does **not** reach the process the wrapper execs, so a
variable a task needs cannot be baked into the image. Use `KODR_SHELL_ENV`:

```bash
KODR_SHELL_ENV="CARGO_NET_OFFLINE=true,RUST_BACKTRACE=1" scripts/kodr-shell.sh run "..."
```

Comma-separated `NAME=VALUE` pairs; values cannot contain a comma.

That sets the variable on kodr's own process **and** passes `--env NAME` so
kodr admits it to the curated environment its children get. Both halves are
needed: without the second, a hook or `run_command` sees the variable unset,
because kodr never hands children the full `process.env` (see
[`specs/tool-run-command.yaml`](../specs/tool-run-command.yaml)). If you pass
your own `--env`, that wins and the wrapper adds nothing.

A workspace config file (`.cargo/config.toml`, say) is often the steadier
option for toolchain settings.

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
| `KODR_SHELL_ENV` | — | Comma-separated `NAME=VALUE` pairs to set for the run |
| `KODR_SHELL_IMAGE_DIR` | `docker/openshell` | Build context for `KODR_SHELL_BUILD=1` |
| `KODR_SHELL_POLICY` | — | Use this policy file instead of the generated one |
| `KODR_SHELL_KEEPALIVE` | `14400` | Seconds the sandbox is held open (four hours); a longer run loses its sandbox, so raise it |
| `KODR_SHELL_READY_TIMEOUT` | `120` | Seconds to wait for `Ready` |
| `KODR_SHELL_OPENSHELL` | `openshell` | Path to the CLI |
| `KODR_SHELL_SANDBOX_ROOT` | `/sandbox` | Writable root inside the sandbox; uploads land at `<root>/<basename>` |
| `KODR_SHELL_DEST` | the workspace's parent | Where `KODR_SHELL_DOWNLOAD=1` writes `<workspace>.returned` |
| `KODR_SHELL_GIT_NAME` | `Kodr Sandbox` | Git author and committer name, passed as environment |
| `KODR_SHELL_GIT_EMAIL` | `kodr@sandbox.invalid` | Git author and committer email, passed as environment |
| `KODR_SHELL_OPEN_HOST` | `openrouter.ai` | Public host `KODR_SHELL_NETWORK=open` also allows |
| `KODR_SHELL_OPEN_PORT` | `443` | Port for `KODR_SHELL_OPEN_HOST` |

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
- **`--no-git-ignore` uploads build output too.** It is required so `.git`
  survives (`kodr loop` resets against it), but it also disables
  `.gitignore` filtering, so a `target/` or `node_modules/` goes up — and
  comes back down. A Rust `target/` reached 78MB after a few turns. Clean the
  build directory between runs if you are chaining turns.
- **A backgrounded command is killed with its process group.** The timeout is
  enforced and the orphan is reaped, including in a sandbox, where
  `kill(-pgid)` is refused outright and the group has to be enumerated and
  killed pid by pid instead. A command that calls `setsid` itself escapes the
  group and is not reached — a known limit.
- **A command that detaches cleanly is reaped at the end of the run.** The
  timeout kill above only fires on a command that overflows, times out or is
  cancelled, so `node server.mjs > /dev/null 2>&1 &` — which exits 0 in
  milliseconds — slipped past it and kept its port after `kodr` exited. The
  run now sweeps the groups its commands left behind before it exits, and
  reports what it killed on stderr. Inside a sandbox this was already
  contained, since the sandbox is deleted at run end; on the host it was a
  real leak. `--keep-orphans` leaves them running, still reported.
- **The wrapper is safe to edit mid-run, but kodr is not.** The script body is
  wrapped in a function so bash parses all of it before executing any, which
  stops an edit during a long run from corrupting the parse. The *uploaded*
  kodr checkout is a snapshot taken at launch, so repo changes after that do
  not affect a run in flight either way.
- **On macOS the sandbox runs inside a Linux VM**, so Landlock and seccomp
  apply there rather than to the host OS. The boundary is real; it is one
  level further out than on Linux.
