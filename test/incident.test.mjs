import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  incidentHeartbeatIntervalMs,
  installIncidentHandlers,
  sweepOrphanedHeartbeats,
  writeIncident,
} from '../src/incident.mjs';

// Safely out of range for a real pid on Linux or macOS, so signal 0 against
// it reliably throws ESRCH -- used to stand in for "a run that's gone" in
// heartbeat-sweep tests, without any chance of a real running process
// coincidentally holding this pid.
const DEAD_PID = 2_147_483_647;

let runsDir;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'kodr-incident-'));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

async function incidentFiles() {
  const entries = await readdir(runsDir);
  return entries.filter((entry) => entry.endsWith('.incident.json'));
}

async function heartbeatFiles() {
  const entries = await readdir(runsDir);
  return entries.filter((entry) => entry.startsWith('.heartbeat-'));
}

describe('writeIncident', () => {
  it('writes a JSON file into runsDir and returns its path', async () => {
    const path = await writeIncident(runsDir, {
      reason: 'signal',
      signal: 'SIGINT',
    });
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.reason, 'signal');
    assert.equal(record.signal, 'SIGINT');
    assert.equal((await incidentFiles()).length, 1);
  });

  it('writes a distinct file for every concurrent call, even in the same millisecond', async () => {
    const paths = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeIncident(runsDir, { reason: 'test', i }),
      ),
    );
    assert.equal(new Set(paths).size, 20);
    assert.equal((await incidentFiles()).length, 20);
  });
});

describe('sweepOrphanedHeartbeats', () => {
  it('returns an empty array when runsDir has no heartbeats', async () => {
    const written = await sweepOrphanedHeartbeats(runsDir);
    assert.deepEqual(written, []);
  });

  it('turns a leftover heartbeat into an incident record', async () => {
    await writeFile(
      join(runsDir, '.heartbeat-4242.json'),
      JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z' }),
    );

    const written = await sweepOrphanedHeartbeats(runsDir);
    assert.equal(written.length, 1);

    const record = JSON.parse(await readFile(written[0], 'utf8'));
    assert.equal(record.reason, 'orphaned-heartbeat');
    assert.equal(record.lastHeartbeat.pid, DEAD_PID);
  });

  it('removes the heartbeat file after sweeping it', async () => {
    await writeFile(
      join(runsDir, '.heartbeat-4242.json'),
      JSON.stringify({ pid: DEAD_PID }),
    );
    await sweepOrphanedHeartbeats(runsDir);
    assert.equal((await heartbeatFiles()).length, 0);
  });

  it('tolerates a corrupt heartbeat file without throwing', async () => {
    await writeFile(join(runsDir, '.heartbeat-4242.json'), 'not json');
    const written = await sweepOrphanedHeartbeats(runsDir);
    assert.deepEqual(written, []);
    assert.equal((await heartbeatFiles()).length, 0);
  });

  it('writes a distinct incident for every dead heartbeat swept in one call', async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(
        join(runsDir, `.heartbeat-${1000 + i}.json`),
        JSON.stringify({ pid: DEAD_PID }),
      );
    }

    const written = await sweepOrphanedHeartbeats(runsDir);
    assert.equal(written.length, 10);
    assert.equal(new Set(written).size, 10);
    assert.equal((await incidentFiles()).length, 10);
  });

  it('leaves a heartbeat whose pid is still alive untouched, not reported as an orphan', async () => {
    // process.pid (this very test process) is guaranteed alive -- stands
    // in for a second `kodr` run sharing the same runsDir.
    await writeFile(
      join(runsDir, `.heartbeat-${process.pid}.json`),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const written = await sweepOrphanedHeartbeats(runsDir);
    assert.deepEqual(written, []);
    assert.equal((await incidentFiles()).length, 0);
    assert.equal((await heartbeatFiles()).length, 1);
  });
});

describe('installIncidentHandlers', () => {
  it('writes an initial heartbeat file when heartbeatMs > 0', async () => {
    const dispose = await installIncidentHandlers({
      runsDir,
      startedAt: new Date(),
      heartbeatMs: 10_000,
    });
    try {
      assert.equal((await heartbeatFiles()).length, 1);
    } finally {
      await dispose();
    }
  });

  it('writes no heartbeat file when heartbeatMs is 0', async () => {
    const dispose = await installIncidentHandlers({
      runsDir,
      startedAt: new Date(),
      heartbeatMs: 0,
    });
    try {
      assert.equal((await heartbeatFiles()).length, 0);
    } finally {
      await dispose();
    }
  });

  it('dispose() removes the heartbeat file', async () => {
    const dispose = await installIncidentHandlers({
      runsDir,
      startedAt: new Date(),
      heartbeatMs: 10_000,
    });
    await dispose();
    assert.equal((await heartbeatFiles()).length, 0);
  });

  it('dispose() is safe to call more than once', async () => {
    const dispose = await installIncidentHandlers({
      runsDir,
      startedAt: new Date(),
      heartbeatMs: 10_000,
    });
    await dispose();
    await assert.doesNotReject(() => dispose());
  });

  it('a SIGINT reaching the installed handler writes a signal incident and calls exit with 130', async () => {
    const exitCalls = [];
    const signalSource = new EventEmitter();
    const dispose = await installIncidentHandlers({
      runsDir,
      startedAt: new Date(),
      heartbeatMs: 0,
      exit: (code) => exitCalls.push(code),
      signalSource,
    });

    // Emit against a fake source rather than the real `process` -- node:test
    // installs its own listeners on process's SIGINT/uncaughtException/etc.
    // to detect a genuinely crashing test, and emitting there would trigger
    // those too.
    signalSource.emit('SIGINT');
    await waitFor(() => exitCalls.length > 0);

    assert.deepEqual(exitCalls, [130]);
    const files = await incidentFiles();
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(join(runsDir, files[0]), 'utf8'));
    assert.equal(record.reason, 'signal');
    assert.equal(record.signal, 'SIGINT');

    await dispose();
  });

  it('an uncaughtException reaching the installed handler writes an incident and calls exit with 1', async () => {
    const exitCalls = [];
    const signalSource = new EventEmitter();
    const dispose = await installIncidentHandlers({
      runsDir,
      startedAt: new Date(),
      heartbeatMs: 0,
      exit: (code) => exitCalls.push(code),
      signalSource,
    });

    signalSource.emit('uncaughtException', new Error('boom'));
    await waitFor(() => exitCalls.length > 0);

    assert.deepEqual(exitCalls, [1]);
    const files = await incidentFiles();
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(join(runsDir, files[0]), 'utf8'));
    assert.equal(record.reason, 'uncaughtException');
    assert.match(record.error.message, /boom/);

    await dispose();
  });
});

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('incidentHeartbeatIntervalMs', () => {
  const envKey = 'KODR_INCIDENT_HEARTBEAT_MS';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('prefers an explicit option', () => {
    process.env[envKey] = '5000';
    assert.equal(incidentHeartbeatIntervalMs(1234), 1234);
  });

  it('falls back to KODR_INCIDENT_HEARTBEAT_MS', () => {
    process.env[envKey] = '5000';
    assert.equal(incidentHeartbeatIntervalMs(undefined), 5000);
  });

  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(incidentHeartbeatIntervalMs(undefined), 30_000);
  });

  it('treats 0 as a valid explicit option, not "unset"', () => {
    process.env[envKey] = '5000';
    assert.equal(incidentHeartbeatIntervalMs(0), 0);
  });
});
