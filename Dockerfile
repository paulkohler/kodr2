# Runtime image for the Kodr isolation box (see scripts/kodr-box.sh and
# specs/docker-isolation.yaml). This is a local testing sandbox, not an image
# meant to be published to a registry.
#
# The image is a pure runtime: it does NOT copy Kodr's source. The wrapper
# mounts the local checkout read-only at /opt/kodr on every run, so source
# edits take effect with no rebuild (Kodr is zero-runtime-dependency, so
# `node /opt/kodr/bin/kodr.mjs` runs straight from the mount). Rebuild only to
# change Node or the toolchain.
FROM node:22-slim

# Batteries-included toolchain so the agent's run_command (tests, builds, git)
# works on most repos without editing this file. iptables + util-linux's
# setpriv (already in the base) back the entrypoint's locked-egress path.
# Extend at build time with --build-arg EXTRA_APT="pkg1 pkg2".
ARG EXTRA_APT=""
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      iptables \
      python3 \
      python3-venv \
      build-essential \
      jq \
      ripgrep \
      curl \
      ${EXTRA_APT} \
 && rm -rf /var/lib/apt/lists/*

COPY docker/kodr-box-entry.sh /usr/local/bin/kodr-box-entry.sh
RUN chmod +x /usr/local/bin/kodr-box-entry.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/kodr-box-entry.sh"]
