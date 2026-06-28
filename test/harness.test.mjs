import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRunRecord, isRunBudgetExceeded, run } from '../src/harness.mjs';

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
        packageCommands: ['npm install express'],
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
    assert.deepEqual(record.packageCommands, ['npm install express']);
    assert.equal(record.error, null);
    assert.equal(record.verified, true);
    assert.equal(record.healTurns, 1);
  });
});

describe('isRunBudgetExceeded', () => {
  it('returns false when no budget is configured', () => {
    const startedAt = new Date(Date.now() - 1000);
    assert.equal(isRunBudgetExceeded(startedAt, 0), false);
  });

  it('returns true when elapsed time reaches the budget', () => {
    const startedAt = new Date(Date.now() - 1000);
    assert.equal(isRunBudgetExceeded(startedAt, 100), true);
  });
});

describe('run failure artifacts', () => {
  it('saves a run record when the model request fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-error-'));
    const server = createServer((req, res) => {
      if (req.url === '/api/v0/models') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(500);
      res.end('model failed');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const result = await run('do work', {
        cwd,
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'test',
        quiet: true,
      });

      assert.equal(result.stoppedReason, 'error');
      assert.match(result.error.message, /HTTP 500/);

      const runDir = join(cwd, '.kodr', 'runs');
      const files = await readdir(runDir);
      assert.equal(files.length, 1);
      const record = JSON.parse(await readFile(join(runDir, files[0]), 'utf8'));
      assert.equal(record.stoppedReason, 'error');
      assert.match(record.error.message, /HTTP 500/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
