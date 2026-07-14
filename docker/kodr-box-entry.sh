#!/usr/bin/env bash
#
# kodr-box-entry.sh — container entrypoint for the Kodr isolation box.
#
# Baked into the image (see Dockerfile) and driven by scripts/kodr-box.sh.
# The container starts as root so it can, in locked mode, program an iptables
# egress allowlist that permits only the host LLM before dropping to the
# caller's UID/GID and exec'ing kodr. This is the one place root is used;
# everything after the setpriv drop runs unprivileged, and files written to
# the mounted /workspace are owned by the host user.
#
# Env (set by the wrapper):
#   KODR_BOX_LOCK        1 = restrict egress to the host LLM (needs NET_ADMIN)
#   KODR_BOX_LOCK_PORTS  comma-separated tcp ports allowed to the host (e.g. 1234,11434)
#   KODR_BOX_HOST        host alias to resolve for the allowlist (default host.docker.internal)
#   KODR_UID / KODR_GID  identity to drop to (default: stay as current uid/gid)
#
# Everything in "$@" is forwarded verbatim to kodr.
set -uo pipefail

KODR_BOX_HOST=${KODR_BOX_HOST:-host.docker.internal}

# Restrict outbound traffic to the host LLM only. Default-drop OUTPUT, then
# allow loopback, already-established flows, and new tcp connections to the
# host gateway on the LLM port(s). No DNS rule is needed: the LLM is reached
# by IP via the /etc/hosts entry from --add-host, not by name resolution.
lock_egress() {
  local host_ip ports port
  host_ip="$(getent hosts "$KODR_BOX_HOST" | awk '{ print $1; exit }')"
  if [ -z "$host_ip" ]; then
    echo "kodr-box: cannot resolve $KODR_BOX_HOST for the egress allowlist" >&2
    echo "kodr-box: refusing to run unlocked; retry with KODR_BOX_NETWORK=open" >&2
    exit 1
  fi

  iptables -P OUTPUT DROP || return 1
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

  ports="${KODR_BOX_LOCK_PORTS:-}"
  if [ -n "$ports" ]; then
    IFS=',' read -ra port_list <<< "$ports"
    for port in "${port_list[@]}"; do
      [ -n "$port" ] && iptables -A OUTPUT -d "$host_ip" -p tcp --dport "$port" -j ACCEPT
    done
  fi
}

if [ "${KODR_BOX_LOCK:-}" = "1" ]; then
  if ! lock_egress; then
    echo "kodr-box: failed to program the egress allowlist (needs --cap-add=NET_ADMIN)" >&2
    echo "kodr-box: on rootless Docker, retry with KODR_BOX_NETWORK=open" >&2
    exit 1
  fi
fi

# Choose the target command. KODR_BOX_SHELL=1 opens an interactive shell in
# the same sandbox (egress lock already applied above) for debugging; the
# default runs kodr with the forwarded args.
if [ "${KODR_BOX_SHELL:-}" = "1" ]; then
  target=(bash)
else
  target=(node /opt/kodr/bin/kodr.mjs "$@")
fi

# Drop to the caller's identity, then hand off. When no UID is given (or we are
# already unprivileged), exec directly.
if [ -n "${KODR_UID:-}" ] && [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid "$KODR_UID" --regid "${KODR_GID:-$KODR_UID}" --clear-groups \
    "${target[@]}"
fi

exec "${target[@]}"
