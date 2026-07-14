#!/usr/bin/env bash
#
# kodr-box.sh — run your LOCAL Kodr checkout inside a container for filesystem
# isolation, against the current directory as the workspace.
#
# Kodr's run_command tool runs arbitrary shell the model writes, with only cd
# targets jailed — so a bad turn can touch anything on disk. This wrapper caps
# that blast radius to one directory: it mounts $PWD rw at /workspace (the only
# writable host path) and mounts the local Kodr checkout ro at /opt/kodr, so
# your Kodr edits take effect with NO rebuild. Egress is restricted to the host
# LLM by default; the model is reached over the LLM API from inside the box.
#
# Usage:
#   cd /path/to/your/repo
#   /path/to/kodr2/scripts/kodr-box.sh run "add input validation" --model <m>
#   kodr-box.sh                        # no args → Kodr's interactive TUI
#
# Everything after the wrapper's own --box-* flags is forwarded verbatim to
# kodr. The wrapper builds the image on first use.
#
# Wrapper flags:
#   --box-build      (re)build the image even if it already exists
#   --box-dry-run    print the assembled `docker` command and run nothing
#   --box-shell      open a shell in the sandbox instead of running kodr (debug)
#
# Config via env (all overridable):
#   KODR_BOX_IMAGE          image tag (default kodr-box)
#   KODR_BOX_NETWORK        locked (default; egress = host LLM only) | open
#   KODR_BOX_HOST           host alias for the LLM (default host.docker.internal)
#   KODR_BOX_LMSTUDIO_PORT  host LM Studio port (default 1234)
#   KODR_BOX_OLLAMA_PORT    host Ollama port (default 11434)
#   KODR_BOX_HOME           writable HOME in the container (default /tmp)
#   KODR_BOX_WORKSPACE      workspace mount point (default /workspace)
#   KODR_BOX_ENV_PASS       host env names to forward (comma-separated)
#   KODR_BOX_DRYRUN=1       same as --box-dry-run
set -uo pipefail

KODR_BOX_IMAGE=${KODR_BOX_IMAGE:-kodr-box}
KODR_BOX_NETWORK=${KODR_BOX_NETWORK:-locked}
KODR_BOX_HOST=${KODR_BOX_HOST:-host.docker.internal}
KODR_BOX_LMSTUDIO_PORT=${KODR_BOX_LMSTUDIO_PORT:-1234}
KODR_BOX_OLLAMA_PORT=${KODR_BOX_OLLAMA_PORT:-11434}
KODR_BOX_HOME=${KODR_BOX_HOME:-/tmp}
KODR_BOX_WORKSPACE=${KODR_BOX_WORKSPACE:-/workspace}
KODR_BOX_ENV_PASS=${KODR_BOX_ENV_PASS:-OPENROUTER_API_KEY,OLLAMA_API_KEY,KODR_PROVIDER,KODR_MODEL,KODR_REASONING,KODR_NO_SAVE}
DRYRUN=${KODR_BOX_DRYRUN:-}

# The Kodr checkout is this script's parent dir, so the wrapper works from any
# CWD (the CWD is the workspace, not the source).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KODR_SRC="$(dirname "$SCRIPT_DIR")"

# --- Separate the wrapper's own flags from the args forwarded to kodr. -------
build=""
shell=""
forward=()
for arg in "$@"; do
  case "$arg" in
    --box-build) build=1 ;;
    --box-dry-run) DRYRUN=1 ;;
    --box-shell) shell=1 ;;
    *) forward+=("$arg") ;;
  esac
done

# --- Preflight (Docker isn't needed to assemble a dry-run command). ----------
if [ -z "$DRYRUN" ]; then
  command -v docker >/dev/null || { echo "kodr-box: docker not on PATH" >&2; exit 1; }
fi
[ -f "$KODR_SRC/bin/kodr.mjs" ] || {
  echo "kodr-box: no Kodr checkout at $KODR_SRC (missing bin/kodr.mjs)" >&2
  exit 1
}

# --- Detect what the user already passed so we never override their choices. --
# Provider precedence mirrors Kodr: --provider, then KODR_PROVIDER, then lmstudio.
provider="${KODR_PROVIDER:-lmstudio}"
has_base_url=""
has_cwd=""
prev=""
for arg in "${forward[@]}"; do
  [ "$prev" = "--provider" ] && provider="$arg"
  [ "$arg" = "--base-url" ] && has_base_url=1
  [ "$arg" = "--cwd" ] && has_cwd=1
  prev="$arg"
done

# --- Injected kodr args (appended after the user's, only when absent). -------
inject=()
[ -z "$has_cwd" ] && inject+=(--cwd "$KODR_BOX_WORKSPACE")
if [ -z "$has_base_url" ]; then
  case "$provider" in
    lmstudio) inject+=(--base-url "http://$KODR_BOX_HOST:$KODR_BOX_LMSTUDIO_PORT/v1") ;;
    ollama)   inject+=(--base-url "http://$KODR_BOX_HOST:$KODR_BOX_OLLAMA_PORT/v1") ;;
    *)        ;; # openrouter (and anything else): reached directly, no injection
  esac
fi

if [ "$provider" = "openrouter" ] && [ "$KODR_BOX_NETWORK" = "locked" ]; then
  echo "kodr-box: provider openrouter needs the internet, but network is locked." >&2
  echo "kodr-box: re-run with KODR_BOX_NETWORK=open." >&2
fi
case "$provider" in
  lmstudio|ollama)
    echo "kodr-box: reaching $provider on the host via $KODR_BOX_HOST — make sure it" >&2
    echo "kodr-box: listens on 0.0.0.0 (LM Studio: 'Serve on Local Network';" >&2
    echo "kodr-box: Ollama: OLLAMA_HOST=0.0.0.0), not just loopback." >&2
    ;;
esac

# --- Build the image on first use (or when forced). --------------------------
if [ -z "$DRYRUN" ]; then
  need_build=""
  docker image inspect "$KODR_BOX_IMAGE" >/dev/null 2>&1 || need_build=1
  [ -n "$build" ] && need_build=1
  if [ -n "$need_build" ]; then
    echo "kodr-box: building image $KODR_BOX_IMAGE ..." >&2
    docker build -t "$KODR_BOX_IMAGE" -f "$KODR_SRC/Dockerfile" "$KODR_SRC" || exit 1
  fi
fi

# --- Assemble the docker invocation. -----------------------------------------
docker_args=(run --rm)

# Interactive TTY only when attached to a terminal (needed for Kodr's TUI);
# omitted when piped, e.g. a one-shot `run` in a script.
if [ -t 0 ] && [ -t 1 ]; then
  docker_args+=(-it)
fi

docker_args+=(--add-host "host.docker.internal:host-gateway")
docker_args+=(-v "$PWD:$KODR_BOX_WORKSPACE")
docker_args+=(-v "$KODR_SRC:/opt/kodr:ro")
docker_args+=(-w "$KODR_BOX_WORKSPACE")
docker_args+=(-e "KODR_UID=$(id -u)" -e "KODR_GID=$(id -g)" -e "HOME=$KODR_BOX_HOME")
docker_args+=(-e "KODR_BOX_HOST=$KODR_BOX_HOST")

# Forward host env vars (by name, so secret values are not echoed in dry-run).
IFS=',' read -ra pass_names <<< "$KODR_BOX_ENV_PASS"
for name in "${pass_names[@]}"; do
  [ -n "$name" ] && [ -n "${!name:-}" ] && docker_args+=(-e "$name")
done

# Locked egress: the entrypoint programs an iptables allowlist (needs NET_ADMIN).
if [ "$KODR_BOX_NETWORK" = "locked" ]; then
  docker_args+=(--cap-add NET_ADMIN)
  docker_args+=(-e "KODR_BOX_LOCK=1")
  docker_args+=(-e "KODR_BOX_LOCK_PORTS=$KODR_BOX_LMSTUDIO_PORT,$KODR_BOX_OLLAMA_PORT")
fi

[ -n "$shell" ] && docker_args+=(-e "KODR_BOX_SHELL=1")

docker_args+=("$KODR_BOX_IMAGE")
# In shell mode the entrypoint ignores forwarded args; otherwise pass the
# user's kodr args followed by our injected defaults.
if [ -z "$shell" ]; then
  docker_args+=("${forward[@]}" "${inject[@]}")
fi

# --- Run, or print the command and stop. -------------------------------------
if [ -n "$DRYRUN" ]; then
  printf '%q ' docker "${docker_args[@]}"
  printf '\n'
  exit 0
fi

exec docker "${docker_args[@]}"
