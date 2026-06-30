import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_HEAL_RESERVE,
  createRunRecord,
  healReserveFraction,
  isRunBudgetExceeded,
  remainingRunBudgetMs,
  run,
  stopVerifyBudgetMs,
} from '../src/harness.mjs';

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

describe('remainingRunBudgetMs', () => {
  it('returns undefined when no budget is configured', () => {
    assert.equal(remainingRunBudgetMs(new Date(), 0), undefined);
  });

  it('returns at least one millisecond when the budget is spent', () => {
    const startedAt = new Date(Date.now() - 1000);
    assert.equal(remainingRunBudgetMs(startedAt, 100), 1);
  });
});

describe('healReserveFraction', () => {
  const saved = process.env.KODR_HEAL_RESERVE;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KODR_HEAL_RESERVE;
    } else {
      process.env.KODR_HEAL_RESERVE = saved;
    }
  });

  it('defaults when nothing is configured', () => {
    delete process.env.KODR_HEAL_RESERVE;
    assert.equal(healReserveFraction(undefined), DEFAULT_HEAL_RESERVE);
  });

  it('reads KODR_HEAL_RESERVE from the environment', () => {
    process.env.KODR_HEAL_RESERVE = '0.4';
    assert.equal(healReserveFraction(undefined), 0.4);
  });

  it('prefers an explicit option over the environment', () => {
    process.env.KODR_HEAL_RESERVE = '0.4';
    assert.equal(healReserveFraction(0.1), 0.1);
  });

  it('clamps to [0, 0.9]', () => {
    delete process.env.KODR_HEAL_RESERVE;
    assert.equal(healReserveFraction(-1), 0);
    assert.equal(healReserveFraction(5), 0.9);
  });
});

describe('stopVerifyBudgetMs', () => {
  it('returns undefined when no run budget is set', () => {
    assert.equal(stopVerifyBudgetMs(new Date(), 0, 0.25), undefined);
  });

  it('holds back the reserve fraction of the remaining budget', () => {
    const startedAt = new Date(Date.now());
    const budget = stopVerifyBudgetMs(startedAt, 1000, 0.25);
    // ~750 of 1000, leaving ~250 for heal (allowing for elapsed ms).
    assert.ok(budget <= 750 && budget >= 700, `got ${budget}`);
  });

  it('reserves nothing when the fraction is zero', () => {
    const startedAt = new Date(Date.now());
    const budget = stopVerifyBudgetMs(startedAt, 1000, 0);
    assert.ok(budget >= 950, `got ${budget}`);
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

async function startFailingModel() {
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
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('run transcript location', () => {
  it('writes the transcript to runsDir, not the workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-runsdir-ws-'));
    const runsDir = await mkdtemp(join(tmpdir(), 'kodr-runsdir-out-'));
    const model = await startFailingModel();
    try {
      await run('do work', {
        cwd,
        runsDir,
        baseUrl: model.baseUrl,
        model: 'test',
        quiet: true,
      });

      const files = await readdir(runsDir);
      assert.equal(files.length, 1);
      // The workspace stays clean — no .kodr created.
      await assert.rejects(() => readdir(join(cwd, '.kodr', 'runs')));
    } finally {
      await model.close();
      await rm(cwd, { recursive: true, force: true });
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  it('skips the transcript entirely when noSave is set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-nosave-'));
    const model = await startFailingModel();
    try {
      await run('do work', {
        cwd,
        noSave: true,
        baseUrl: model.baseUrl,
        model: 'test',
        quiet: true,
      });

      await assert.rejects(() => readdir(join(cwd, '.kodr', 'runs')));
    } finally {
      await model.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
