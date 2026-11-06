# Sandbox image for scripts/kodr-shell.sh (specs/openshell-isolation.yaml).
#
# Kodr has no runtime dependencies, so this installs no packages for Kodr
# itself -- it is uploaded and run straight from the mount. Everything here is
# either required by the harness or by the tasks a model will plausibly run.
#
# Pinned to the current Krypton LTS patch, which also carries the fix for
# CVE-2026-111497, the out-of-bounds write in Brotli's decoder reachable
# through node:zlib. Kodr's own code never decompresses anything, but
# run_command spawns a shell and a model-run script might, so the sandbox
# should not be the weakest Node on the machine. Pinned rather than floating
# on :24 so a rebuild cannot quietly move the runtime under a loop.
FROM node:24.22.2-bookworm-slim

# procps is not optional: shell.mjs shells out to `ps -Ao pid,ppid` to find a
# timed-out command's descendants, and without it the orphan kill degrades to
# signalling only the direct /bin/sh child (see specs/shell.yaml).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      procps \
      git \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# No USER line and no useradd: OpenShell's policy decides who the workload
# runs as. 0.1.7's default drops the `process:` block and uses the image's own
# user (node), where the 0.0.x policy pinned a `sandbox` account -- adding one
# here just invites the two to disagree.
