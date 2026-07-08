import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { computeStats, loadRunRecords } from '../src/stats.mjs';

let runsDir;

afterEach(async () => {
  if (runsDir) {
    await rm(runsDir, { recursive: true, force: true });
    runsDir = undefined;
  }
});

function record(overrides = {}) {
  return {
    stoppedReason: 'complete',
    toolTurns: 2,
    usage: { prompt: 10, completion: 5 },
    compactions: 0,
    retries: 0,
    verified: null,
    noOpCompletion: false,
    healed: null,
    durationMs: 100,
    ...overrides,
  };
}

describe('loadRunRecords', () => {
  it('reads and parses every run record json file in a directory', async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'kodr-stats-'));
    await writeFile(
      join(runsDir, '2026-01-01T00-00-00-000Z.json'),
      JSON.stringify(record({ toolTurns: 3 })),
      'utf8',
    );
    await writeFile(
      join(runsDir, '2026-01-02T00-00-00-000Z.json'),
      JSON.stringify(record({ toolTurns: 5 })),
      'utf8',
    );

    const records = await loadRunRecords(runsDir);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.toolTurns).sort(), [3, 5]);
  });

  it('skips *-debug.jsonl sidecar files', async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'kodr-stats-'));
    await writeFile(
      join(runsDir, '2026-01-01T00-00-00-000Z.json'),
      JSON.stringify(record()),
      'utf8',
    );
    await writeFile(
      join(runsDir, '2026-01-01T00-00-00-000Z-debug.jsonl'),
      '{"rawResponse":"x"}\n',
      'utf8',
    );

    const records = await loadRunRecords(runsDir);
    assert.equal(records.length, 1);
  });

  it('skips a file that fails to parse, without throwing', async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'kodr-stats-'));
    await writeFile(
      join(runsDir, '2026-01-01T00-00-00-000Z.json'),
      JSON.stringify(record()),
      'utf8',
    );
    await writeFile(
      join(runsDir, '2026-01-02T00-00-00-000Z.json'),
      'not valid json{{{',
      'utf8',
    );

    const records = await loadRunRecords(runsDir);
    assert.equal(records.length, 1);
  });

  it('returns an empty array for a missing or empty directory', async () => {
    runsDir = join(await mkdtemp(join(tmpdir(), 'kodr-stats-')), 'missing');
    assert.deepEqual(await loadRunRecords(runsDir), []);
  });
});

describe('computeStats', () => {
  it('returns { total: 0 } for an empty record set', () => {
    assert.deepEqual(computeStats([]), { total: 0 });
  });

  it('counts runs per stoppedReason', () => {
    const stats = computeStats([
      record({ stoppedReason: 'complete' }),
      record({ stoppedReason: 'complete' }),
      record({ stoppedReason: 'error' }),
    ]);
    assert.deepEqual(stats.stoppedReasonCounts, { complete: 2, error: 1 });
  });

  it('computes noOpRate from noOpCompletion', () => {
    const stats = computeStats([
      record({ noOpCompletion: true }),
      record({ noOpCompletion: false }),
    ]);
    assert.equal(stats.noOpRate, 0.5);
  });

  it('computes healAttemptedRate and healSuccessRate', () => {
    const stats = computeStats([
      record({ healed: true }),
      record({ healed: false }),
      record({ healed: null }),
      record({ healed: null }),
    ]);
    assert.equal(stats.healAttemptedRate, 0.5);
    assert.equal(stats.healSuccessRate, 0.5);
  });

  it('reports healSuccessRate as null when no run attempted healing', () => {
    const stats = computeStats([
      record({ healed: null }),
      record({ healed: null }),
    ]);
    assert.equal(stats.healAttemptedRate, 0);
    assert.equal(stats.healSuccessRate, null);
  });

  it('computes compactionRate and avgCompactions', () => {
    const stats = computeStats([
      record({ compactions: 2 }),
      record({ compactions: 0 }),
    ]);
    assert.equal(stats.compactionRate, 0.5);
    assert.equal(stats.avgCompactions, 1);
  });

  it('computes retryRate and avgRetries', () => {
    const stats = computeStats([
      record({ retries: 3 }),
      record({ retries: 0 }),
      record({ retries: 1 }),
    ]);
    assert.equal(stats.retryRate, 2 / 3);
    assert.equal(stats.avgRetries, 4 / 3);
  });

  it('computes verifyAttemptedRate and verifyPassRate', () => {
    const stats = computeStats([
      record({ verified: true }),
      record({ verified: false }),
      record({ verified: null }),
    ]);
    assert.equal(stats.verifyAttemptedRate, 2 / 3);
    assert.equal(stats.verifyPassRate, 0.5);
  });

  it('reports verifyPassRate as null when no run was verified', () => {
    const stats = computeStats([record({ verified: null })]);
    assert.equal(stats.verifyPassRate, null);
  });

  it('computes avgToolTurns and avgDurationMs across the set', () => {
    const stats = computeStats([
      record({ toolTurns: 2, durationMs: 100 }),
      record({ toolTurns: 4, durationMs: 300 }),
    ]);
    assert.equal(stats.avgToolTurns, 3);
    assert.equal(stats.avgDurationMs, 200);
  });

  it('sums prompt/completion/cost usage across the set', () => {
    const stats = computeStats([
      record({ usage: { prompt: 10, completion: 5, cost: 0.001 } }),
      record({ usage: { prompt: 20, completion: 8, cost: 0.002 } }),
    ]);
    assert.deepEqual(stats.totalUsage, {
      prompt: 30,
      completion: 13,
      cost: 0.003,
    });
  });
});
