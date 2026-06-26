import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRunRecord } from '../src/harness.mjs';

describe('createRunRecord', () => {
  it('includes run metadata and duration', () => {
    const record = createRunRecord(
      {
        metadata: {
          cwd: '/tmp/work',
          prompt: 'do work',
          baseUrl: 'http://localhost:1234/v1',
          model: 'qwen/test',
          testCommand: 'node --test',
          maxHealTurns: 3,
          envPassthrough: ['CI'],
          startedAt: '2026-01-01T00:00:00.000Z',
        },
        filesChanged: ['src/a.mjs'],
        toolTurns: 2,
        stoppedReason: 'complete',
        usage: { prompt: 10, completion: 5 },
        verification: { passed: true },
        healed: false,
        healTurns: 1,
        messages: [],
      },
      {
        finishedAt: '2026-01-01T00:00:02.500Z',
        durationMs: 2500,
      },
    );

    assert.equal(record.timestamp, '2026-01-01T00:00:02.500Z');
    assert.equal(record.durationMs, 2500);
    assert.equal(record.metadata.model, 'qwen/test');
    assert.equal(record.metadata.prompt, 'do work');
    assert.equal(record.metadata.testCommand, 'node --test');
    assert.equal(record.verified, true);
    assert.equal(record.healTurns, 1);
  });
});
