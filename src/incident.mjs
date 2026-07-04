/**
 * Structured telemetry for a run that terminates unexpectedly.
 *
 * Catchable terminations (SIGINT, SIGTERM, an uncaught exception or
 * unhandled rejection that escapes the harness's own try/catch) get a
 * normal incident record before the process exits. A true SIGKILL, an OOM
 * kill, or a full host freeze can't run any code at the moment it
 * happens -- the only way to notice those after the fact is a heartbeat
 * file that the *next* run finds still sitting there with no matching
 * clean exit, which is itself the evidence.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HEARTBEAT_PREFIX = '.heartbeat-';

export const DEFAULT_INCIDENT_HEARTBEAT_MS = 30_000;

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/**
 * Interval for updating the on-disk heartbeat used to detect a run that
 * never got the chance to clean up after itself. Resolved from an
 * explicit option, then KODR_INCIDENT_HEARTBEAT_MS, then the default; 0
 * disables the heartbeat (and therefore orphan detection), but signal and
 * exception handling still run.
 * @param {number} [option]
 * @returns {number}
 */
export function incidentHeartbeatIntervalMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_INCIDENT_HEARTBEAT_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_INCIDENT_HEARTBEAT_MS;
}

function heartbeatPath(runsDir, pid) {
  return join(runsDir, `${HEARTBEAT_PREFIX}${pid}.json`);
}

async function writeHeartbeat(runsDir, record) {
  await mkdir(runsDir, { recursive: true });
  await writeFile(
    heartbeatPath(runsDir, record.pid),
    JSON.stringify(record, null, 2),
    'utf8',
  );
}

async function clearHeartbeat(runsDir, pid) {
  await unlink(heartbeatPath(runsDir, pid)).catch(() => {});
}

/**
 * Write a structured incident record alongside the run transcript.
 * @param {string} runsDir
 * @param {object} record
 * @returns {Promise<string>} Path written
 */
export async function writeIncident(runsDir, record) {
  await mkdir(runsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The timestamp alone is only millisecond-resolution: two incidents in
  // the same process (a double signal, sweeping several stale heartbeats
  // in one pass) can land in the same millisecond and silently overwrite
  // each other without the random suffix.
  const file = join(
    runsDir,
    `${timestamp}-${randomUUID().slice(0, 8)}.incident.json`,
  );
  await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  return file;
}

function systemSnapshot() {
  return {
    memoryUsage: process.memoryUsage(),
    uptimeSec: process.uptime(),
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find heartbeats left behind by a run that never cleanly exited -- no
 * signal handler, no caught error, nothing: the process was just gone.
 * Turns each into an incident record and removes the stale heartbeat so
 * it isn't reported again on the next sweep.
 *
 * A heartbeat whose pid is still alive belongs to a `kodr` run that's
 * genuinely in progress (two runs can share a runsDir -- two terminal
 * tabs, a script looping over tasks) and must be left alone entirely:
 * neither reported as an incident nor deleted.
 * @param {string} runsDir
 * @returns {Promise<string[]>} Incident file paths written
 */
export async function sweepOrphanedHeartbeats(runsDir) {
  let entries;
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }

  const written = [];
  for (const entry of entries) {
    if (!entry.startsWith(HEARTBEAT_PREFIX) || !entry.endsWith('.json')) {
      continue;
    }
    const path = join(runsDir, entry);
    let heartbeat;
    try {
      heartbeat = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      // Corrupt or partial write -- nothing usable to record, but still
      // worth clearing below so it isn't reported forever.
      await unlink(path).catch(() => {});
      continue;
    }

    if (isProcessAlive(heartbeat?.pid)) {
      continue;
    }

    written.push(
      await writeIncident(runsDir, {
        reason: 'orphaned-heartbeat',
        detectedAt: new Date().toISOString(),
        lastHeartbeat: heartbeat,
      }),
    );
    await unlink(path).catch(() => {});
  }
  return written;
}

/**
 * Install process-level telemetry for a single run: a periodic heartbeat
 * (so a real SIGKILL is noticed by the *next* run's sweepOrphanedHeartbeats)
 * plus handlers for the terminations Node can actually catch.
 * @param {object} params
 * @param {string} params.runsDir
 * @param {Date} params.startedAt
 * @param {number} [params.heartbeatMs] - 0 disables the heartbeat
 * @param {function} [params.exit] - Overridable for tests; defaults to process.exit
 * @param {object} [params.signalSource] - Overridable for tests; defaults to
 *   the real `process`. Needs `on`/`removeListener`. Real `SIGINT`/
 *   `uncaughtException`/etc. events must not be synthesized against the
 *   real `process` in-process, since node:test installs its own listeners
 *   on those same events to detect a genuinely crashing test.
 * @returns {Promise<function(): Promise<void>>} dispose
 */
export async function installIncidentHandlers({
  runsDir,
  startedAt,
  heartbeatMs = DEFAULT_INCIDENT_HEARTBEAT_MS,
  exit = process.exit,
  signalSource = process,
}) {
  const pid = process.pid;
  let heartbeatTimer;

  const updateHeartbeat = () =>
    writeHeartbeat(runsDir, {
      pid,
      startedAt: startedAt.toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    }).catch(() => {});

  if (heartbeatMs > 0) {
    await updateHeartbeat();
    heartbeatTimer = setInterval(updateHeartbeat, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  const elapsedMs = () => Date.now() - startedAt.getTime();

  let disposed = false;
  async function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
      signalSource.removeListener(signal, signalListeners[signal]);
    }
    signalSource.removeListener('uncaughtException', onUncaughtException);
    signalSource.removeListener('unhandledRejection', onUnhandledRejection);
    if (heartbeatMs > 0) {
      await clearHeartbeat(runsDir, pid);
    }
  }

  const onSignal = (signal) => async () => {
    await writeIncident(runsDir, {
      reason: 'signal',
      signal,
      detectedAt: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      system: systemSnapshot(),
    });
    await dispose();
    exit(SIGNAL_EXIT_CODES[signal]);
  };

  const onUncaughtException = async (err) => {
    process.stderr.write(`${err?.stack || err}\n`);
    await writeIncident(runsDir, {
      reason: 'uncaughtException',
      error: { message: err?.message, stack: err?.stack },
      detectedAt: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      system: systemSnapshot(),
    });
    await dispose();
    exit(1);
  };

  const onUnhandledRejection = async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`${err.stack}\n`);
    await writeIncident(runsDir, {
      reason: 'unhandledRejection',
      error: { message: err.message, stack: err.stack },
      detectedAt: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      system: systemSnapshot(),
    });
    await dispose();
    exit(1);
  };

  const signalListeners = {};
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    signalListeners[signal] = onSignal(signal);
    signalSource.on(signal, signalListeners[signal]);
  }
  signalSource.on('uncaughtException', onUncaughtException);
  signalSource.on('unhandledRejection', onUnhandledRejection);

  return dispose;
}
