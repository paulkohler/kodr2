#!/usr/bin/env bash
# Run a local Kodr checkout inside an NVIDIA OpenShell sandbox
# (specs/openshell-isolation.yaml). An external wrapper, not a Kodr feature:
# nothing under src/ knows it is sandboxed.
#
#   scripts/kodr-shell.sh run "fix the failing test" --test "npm test"
#   scripts/kodr-shell.sh loop --test "node --test check.mjs" --max-attempts 2
#
# Why: run_command jails only `cd` targets and nothing constrains egress (see
# specs/tool-run-command.yaml), so a bad model turn can read anything your
# user can read and POST it anywhere. OpenShell matches egress rules against
# the *calling binary*, so node reaching the model endpoint and a model-issued
# curl reaching the same host and port are different decisions.
#
# Verified against OpenShell CLI/gateway 0.1.7. The CLI is pre-1.0 and its
# flags move: this assembles commands and asserts nothing beyond that, so a
# CLI change should break the dry-run tests loudly rather than quietly
# produce a sandbox with no rules.
#
# KODR_SHELL_DRYRUN=1 prints the generated policy and every command, and runs
# nothing. That is what test/openshell-isolation.test.mjs drives, so the tests
# need neither OpenShell nor Docker.
set -euo pipefail

# Everything lives in main(), called at the very bottom. Bash reads a script
# incrementally from a file offset as it executes, so editing the file under a
# running shell shifts those offsets and the shell parses garbage -- observed
# as `syntax error near unexpected token \`do'` partway through a multi-hour
# run, after this file was edited in the repo while that run was in flight. A
# function body has to be parsed complete before it can be called, so the
# whole script is in memory before any of it runs. That matters here more than
# most places: this wrapper exists to drive unattended runs that last hours,
# which is exactly when someone is most likely to be editing the repo.
#
# Deliberately not indented: the policy heredoc below is whitespace-sensitive
# YAML, and bash does not care.
main() {

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

SANDBOX_NAME="${KODR_SHELL_SANDBOX:-kodr-shell-$$}"
HOST_ALIAS="${KODR_SHELL_HOST:-host.openshell.internal}"
LMSTUDIO_PORT="${KODR_SHELL_LMSTUDIO_PORT:-1234}"
OLLAMA_PORT="${KODR_SHELL_OLLAMA_PORT:-11434}"
NODE_IN="${KODR_SHELL_NODE:-/usr/local/bin/node}"
WORKSPACE="$(cd "${KODR_SHELL_WORKSPACE:-$PWD}" && pwd)"
KODR_SRC="$(cd "${KODR_SHELL_SRC:-$REPO}" && pwd)"
IMAGE="${KODR_SHELL_IMAGE:-kodr-shell:latest}"
IMAGE_DIR="${KODR_SHELL_IMAGE_DIR:-$REPO/docker/openshell}"
BUILD="${KODR_SHELL_BUILD:-0}"
SANDBOX_ROOT="${KODR_SHELL_SANDBOX_ROOT:-/sandbox}"
NETWORK="${KODR_SHELL_NETWORK:-locked}"
PROVIDER_RECORD="${KODR_SHELL_PROVIDER_RECORD:-}"
KEEP="${KODR_SHELL_KEEP:-0}"
DOWNLOAD="${KODR_SHELL_DOWNLOAD:-0}"
DEST="${KODR_SHELL_DEST:-$(dirname "$WORKSPACE")}"
POLICY_OVERRIDE="${KODR_SHELL_POLICY:-}"
KEEPALIVE="${KODR_SHELL_KEEPALIVE:-14400}"
READY_TIMEOUT="${KODR_SHELL_READY_TIMEOUT:-120}"
EXTRA_ENV="${KODR_SHELL_ENV:-}"
GIT_NAME="${KODR_SHELL_GIT_NAME:-Kodr Sandbox}"
GIT_EMAIL="${KODR_SHELL_GIT_EMAIL:-kodr@sandbox.invalid}"
OPEN_HOST="${KODR_SHELL_OPEN_HOST:-openrouter.ai}"
OPEN_PORT="${KODR_SHELL_OPEN_PORT:-443}"
DRYRUN="${KODR_SHELL_DRYRUN:-0}"
OPENSHELL="${KODR_SHELL_OPENSHELL:-openshell}"

ws_name="$(basename "$WORKSPACE")"
kodr_name="$(basename "$KODR_SRC")"
# `--upload LOCAL DEST` lands the directory at DEST/<basename LOCAL>, not at
# DEST. Getting this wrong costs a MODULE_NOT_FOUND on the first run.
ws_in="${SANDBOX_ROOT}/${ws_name}"
kodr_in="${SANDBOX_ROOT}/${kodr_name}"

args=("$@")
have_base=0
have_cwd=0
have_env_flag=0
provider=lmstudio
prev=""
for a in "${args[@]+"${args[@]}"}"; do
  case "$a" in
    --base-url | --base-url=*) have_base=1 ;;
    --cwd | --cwd=*) have_cwd=1 ;;
    --env | --env=*) have_env_flag=1 ;;
    openrouter | ollama | lmstudio) if [ "$prev" = "--provider" ]; then provider="$a"; fi ;;
    --provider=*) provider="${a#--provider=}" ;;
  esac
  prev="$a"
done

# Which port the policy opens and the base URL points at. openrouter is
# reached over the public internet, so it gets no base-url injection and no
# host rule -- it needs KODR_SHELL_NETWORK=open instead.
model_port="$LMSTUDIO_PORT"
inject_base=1
case "$provider" in
  ollama) model_port="$OLLAMA_PORT" ;;
  openrouter) inject_base=0 ;;
esac
if [ "$have_base" = 1 ]; then inject_base=0; fi

if [ "$inject_base" = 1 ]; then
  args+=(--base-url "http://${HOST_ALIAS}:${model_port}/v1")
fi
if [ "$have_cwd" = 0 ]; then
  args+=(--cwd "$ws_in")
fi

if [ "$DOWNLOAD" = 1 ] && [ "$KEEP" != 1 ]; then
  echo "kodr-shell: KODR_SHELL_DOWNLOAD=1 needs KODR_SHELL_KEEP=1 -- the sandbox is deleted on exit otherwise" >&2
  exit 2
fi

# The policy is generated rather than shipped as a fixture so it cannot
# disagree with the base URL: overriding KODR_SHELL_HOST or the port has to
# move the allowed endpoint too, or egress is denied in a way that reads
# exactly like a bad base URL. KODR_SHELL_POLICY overrides with a file.
generate_policy() {
  cat <<POLICY
# Generated by scripts/kodr-shell.sh -- edits here are overwritten.
# Shape taken from OpenShell 0.1.7's own default (openshell policy get <s> --full):
# read_write covers only /tmp and /dev/null, with the workspace coming from
# include_workdir, and no process: block (the image's user is used).
version: 1
filesystem_policy:
  include_workdir: true
  read_only:
    - /bin
    - /usr
    - /lib
    - /proc
    - /dev/urandom
    - /etc
    - /var/log
  read_write:
    - /tmp
    - /dev/null
landlock:
  compatibility: best_effort
network_policies:
POLICY
  if [ "$provider" != openrouter ]; then
    cat <<POLICY
  host-model:
    name: host-model
    endpoints:
      - host: ${HOST_ALIAS}
        port: ${model_port}
        access: full
    binaries:
      - path: ${NODE_IN}
POLICY
  fi
  if [ "$NETWORK" = open ]; then
    cat <<POLICY
  provider-public:
    name: provider-public
    endpoints:
      - host: ${OPEN_HOST}
        port: ${OPEN_PORT}
        access: full
    binaries:
      - path: ${NODE_IN}
POLICY
  fi
}

# mktemp -d, not mktemp with a template: BSD/macOS mktemp requires the Xs at
# the end of the template, so `kodr-shell-policy.XXXXXX.yaml` fails outright
# with "mkstemp failed ... File exists". A directory keeps the .yaml name.
# Dry-run writes the file through this same path rather than short-circuiting
# it, so the dry-run tests actually exercise the write -- skipping it here is
# what let that mktemp bug ship past 24 green tests.
policy_dir=""
policy_file="$POLICY_OVERRIDE"
if [ -z "$policy_file" ]; then
  policy_dir="$(mktemp -d "${TMPDIR:-/tmp}/kodr-shell.XXXXXX")"
  policy_file="$policy_dir/policy.yaml"
  generate_policy >"$policy_file"
  if [ "$DRYRUN" = 1 ]; then
    echo "--- generated policy ($policy_file) ---"
    cat "$policy_file"
    echo "--- end policy ---"
  fi
fi

emit() {
  if [ "$DRYRUN" = 1 ]; then
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

cleanup() {
  if [ -n "$policy_dir" ]; then rm -rf "$policy_dir"; fi
  if [ "$DRYRUN" = 1 ] || [ "$KEEP" = 1 ]; then return; fi
  "$OPENSHELL" sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_ready() {
  if [ "$DRYRUN" = 1 ]; then
    echo "# poll '$OPENSHELL sandbox list' until $SANDBOX_NAME is Ready (<= ${READY_TIMEOUT}s)"
    return 0
  fi
  local i
  for ((i = 0; i < READY_TIMEOUT; i += 2)); do
    if "$OPENSHELL" sandbox list 2>/dev/null |
      awk -v n="$SANDBOX_NAME" '$1==n && $NF=="Ready"{f=1} END{exit !f}'; then
      return 0
    fi
    sleep 2
  done
  echo "kodr-shell: sandbox $SANDBOX_NAME not Ready after ${READY_TIMEOUT}s" >&2
  return 1
}

# 0.1.7 wants an image reference: --from stopped building a Dockerfile.
if [ "$BUILD" = 1 ]; then emit docker build -t "$IMAGE" "$IMAGE_DIR"; fi

create=("$OPENSHELL" sandbox create --name "$SANDBOX_NAME" --from "$IMAGE" --policy "$policy_file")
if [ -n "$PROVIDER_RECORD" ]; then create+=(--provider "$PROVIDER_RECORD"); fi
# A sandbox whose main command exits goes to Completed and can no longer be
# exec'd into, so it is held open by a keepalive -- which means `create`
# blocks and has to run detached.
if [ "$DRYRUN" = 1 ]; then
  emit "${create[@]}" -- sleep "$KEEPALIVE"
else
  nohup "${create[@]}" -- sleep "$KEEPALIVE" \
    >"${TMPDIR:-/tmp}/${SANDBOX_NAME}.create.log" 2>&1 </dev/null &
  disown
fi
wait_ready

# --no-git-ignore or .git is silently dropped, and `kodr loop` has no history
# to reset to. Kodr is uploaded, never installed: zero dependencies is what
# lets this work behind a default-deny fence with no registry egress at all.
emit "$OPENSHELL" sandbox upload "$SANDBOX_NAME" "$KODR_SRC" "$SANDBOX_ROOT" --no-git-ignore
emit "$OPENSHELL" sandbox upload "$SANDBOX_NAME" "$WORKSPACE" "$SANDBOX_ROOT" --no-git-ignore

# Git identity through the environment. The shell runner replaces the child
# environment with its curated allowlist, which now carries the GIT_* identity
# pair (see specs/tool-run-command.yaml) -- without that the loop does all its
# work and then dies "Author identity unknown" on its first commit, since the
# sandbox has no ~/.gitconfig.
# An image ENV line does not reach the exec'd process at all, so a variable a
# task needs (CARGO_NET_OFFLINE=true, say) cannot be baked into the image.
# KODR_SHELL_ENV sets it on kodr's own process -- but that alone is not
# enough: kodr replaces its children's environment with a curated allowlist
# (see specs/tool-run-command.yaml), so hooks and run_command would still see
# it UNSET. Each name is therefore also declared to kodr with --env, which is
# what admits it to that allowlist. Both halves are needed; verified in a
# sandbox, where the prefix alone printed UNSET from a probe hook.
env_prefix=(env
  "GIT_AUTHOR_NAME=$GIT_NAME" "GIT_AUTHOR_EMAIL=$GIT_EMAIL"
  "GIT_COMMITTER_NAME=$GIT_NAME" "GIT_COMMITTER_EMAIL=$GIT_EMAIL")
extra_names=""
if [ -n "$EXTRA_ENV" ]; then
  # NAME=VALUE pairs, comma-separated. Values may not contain a comma.
  old_ifs="$IFS"
  IFS=','
  for pair in $EXTRA_ENV; do
    case "$pair" in
      *=*)
        env_prefix+=("$pair")
        name="${pair%%=*}"
        if [ -n "$extra_names" ]; then
          extra_names="$extra_names,$name"
        else
          extra_names="$name"
        fi
        ;;
      '') ;;
      *) echo "kodr-shell: ignoring KODR_SHELL_ENV entry '$pair' (want NAME=VALUE)" >&2 ;;
    esac
  done
  IFS="$old_ifs"
fi
# Only when the caller has not passed their own --env, which wins.
if [ -n "$extra_names" ] && [ "$have_env_flag" = 0 ]; then
  args+=(--env "$extra_names")
fi

rc=0
emit "$OPENSHELL" sandbox exec -n "$SANDBOX_NAME" --no-tty -- "${env_prefix[@]}" \
  "$NODE_IN" "${kodr_in}/bin/kodr.mjs" "${args[@]}" || rc=$?

if [ "$DOWNLOAD" = 1 ]; then
  # Upload nests under DEST/<basename>; download writes the contents straight
  # into the local path. Land beside the original rather than over it.
  out="${DEST}/${ws_name}.returned"
  emit mkdir -p "$out"
  emit "$OPENSHELL" sandbox download "$SANDBOX_NAME" "$ws_in" "$out" ||
    echo "kodr-shell: download failed" >&2
  echo "kodr-shell: workspace returned to $out" >&2
fi
if [ "$KEEP" = 1 ]; then
  echo "kodr-shell: sandbox left running -- $OPENSHELL sandbox delete $SANDBOX_NAME" >&2
fi
exit "$rc"
}

main "$@"
