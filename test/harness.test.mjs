import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createRunRecord,
  DEFAULT_HEAL_RESERVE,
  DEFAULT_HEARTBEAT_MS,
  healReserveFraction,
  heartbeatIntervalMs,
  isRunBudgetExceeded,
  modelMaxRetries,
  remainingRunBudgetMs,
  reviewSkippedForIncompleteBuild,
  run,
  runReviewPass,
  stopVerifyBudgetMs,
} from '../src/harness.mjs';
import { DEFAULT_MAX_RETRIES } from '../src/model.mjs';

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
        noOpCompletion: false,
        retries: 2,
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
    assert.equal(record.noOpCompletion, false);
    assert.equal(record.retries, 2);
  });

  it('defaults retries to 0 rather than undefined', () => {
    const record = createRunRecord(
      { metadata: {}, filesChanged: [], toolTurns: 0, usage: {}, messages: [] },
      {},
    );
    assert.equal(record.retries, 0);
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

describe('heartbeatIntervalMs', () => {
  const saved = process.env.KODR_HEARTBEAT_MS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KODR_HEARTBEAT_MS;
    } else {
      process.env.KODR_HEARTBEAT_MS = saved;
    }
  });

  it('defaults when nothing is configured', () => {
    delete process.env.KODR_HEARTBEAT_MS;
    assert.equal(heartbeatIntervalMs(undefined), DEFAULT_HEARTBEAT_MS);
  });

  it('reads KODR_HEARTBEAT_MS from the environment', () => {
    process.env.KODR_HEARTBEAT_MS = '5000';
    assert.equal(heartbeatIntervalMs(undefined), 5000);
  });

  it('prefers an explicit option over the environment', () => {
    process.env.KODR_HEARTBEAT_MS = '5000';
    assert.equal(heartbeatIntervalMs(1000), 1000);
  });

  it('allows 0 to disable heartbeats', () => {
    delete process.env.KODR_HEARTBEAT_MS;
    assert.equal(heartbeatIntervalMs(0), 0);
  });
});

describe('modelMaxRetries', () => {
  const saved = process.env.KODR_MODEL_RETRIES;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KODR_MODEL_RETRIES;
    } else {
      process.env.KODR_MODEL_RETRIES = saved;
    }
  });

  it('defaults when nothing is configured', () => {
    delete process.env.KODR_MODEL_RETRIES;
    assert.equal(modelMaxRetries(undefined), DEFAULT_MAX_RETRIES);
  });

  it('reads KODR_MODEL_RETRIES from the environment', () => {
    process.env.KODR_MODEL_RETRIES = '3';
    assert.equal(modelMaxRetries(undefined), 3);
  });

  it('prefers an explicit option over the environment', () => {
    process.env.KODR_MODEL_RETRIES = '3';
    assert.equal(modelMaxRetries(0), 0);
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

describe('no-op completion', () => {
  it('flags a run that completes without touching the workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-noop-'));
    const server = createServer((req, res) => {
      if (req.url === '/api/v0/models') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"role":"assistant","content":"nothing to change"}}]}\n\n' +
          'data: [DONE]\n\n',
      );
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

      assert.equal(result.stoppedReason, 'complete');
      assert.equal(result.noOpCompletion, true);
      assert.deepEqual(result.filesChanged, []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`),
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

describe('priorFilesChanged wiring', () => {
  it("carries a continued run's prior filesChanged into this session's own tracking and its raw commit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-continue-'));
    await git(cwd, ['init']);
    await git(cwd, ['config', 'user.email', 'test@test.com']);
    await git(cwd, ['config', 'user.name', 'test']);
    // Simulates the interrupted run's own uncommitted output, still sitting
    // on disk when the continuation session starts.
    await writeFile(join(cwd, 'prior.mjs'), 'export const a = 1;\n');

    const server = createServer((req, res) => {
      if (req.url === '/api/v0/models') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"role":"assistant","content":"nothing more to change"}}]}\n\n' +
          'data: [DONE]\n\n',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const result = await run('continue the previous work', {
        cwd,
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'test',
        quiet: true,
        rawThenFixCommits: true,
        priorFilesChanged: ['prior.mjs'],
      });

      // This session's own tool calls touched nothing new, but the prior
      // run's file is still reflected -- not lost just because this
      // session didn't re-touch it.
      assert.deepEqual(result.filesChanged, ['prior.mjs']);
      assert.equal(result.commits.raw.committed, true);
      const filesInCommit = await git(cwd, [
        'show',
        '--name-only',
        '--format=',
      ]);
      assert.equal(filesInCommit, 'prior.mjs');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('retries telemetry', () => {
  it("sums a retried model request into the run's total retries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-retries-'));
    let calls = 0;
    const server = createServer((req, res) => {
      if (req.url === '/api/v0/models') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      calls++;
      if (calls === 1) {
        res.writeHead(500);
        res.end('internal error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"role":"assistant","content":"done"}}]}\n\n' +
          'data: [DONE]\n\n',
      );
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

      assert.equal(result.stoppedReason, 'complete');
      assert.equal(result.retries, 1);

      const runDir = join(cwd, '.kodr', 'runs');
      const files = await readdir(runDir);
      const record = JSON.parse(await readFile(join(runDir, files[0]), 'utf8'));
      assert.equal(record.retries, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('cost telemetry', () => {
  it("carries a provider's usage.cost through to the run result and saved record", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-cost-'));
    const server = createServer((req, res) => {
      if (req.url === '/api/v0/models') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"role":"assistant","content":"done"}}],' +
          '"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.00042}}\n\n' +
          'data: [DONE]\n\n',
      );
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

      assert.equal(result.stoppedReason, 'complete');
      assert.equal(result.usage.cost, 0.00042);

      const runDir = join(cwd, '.kodr', 'runs');
      const files = await readdir(runDir);
      const record = JSON.parse(await readFile(join(runDir, files[0]), 'utf8'));
      assert.equal(record.usage.cost, 0.00042);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('incident tracking cleanup on setup failure', () => {
  it('disposes the heartbeat file when provider construction throws (e.g. missing OPENROUTER_API_KEY)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-setup-fail-'));
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    try {
      await assert.rejects(
        run('do work', {
          cwd,
          provider: 'openrouter',
          model: 'test',
          quiet: true,
        }),
      );

      const runDir = join(cwd, '.kodr', 'runs');
      const files = await readdir(runDir).catch(() => []);
      const heartbeatFiles = files.filter((f) => f.startsWith('.heartbeat-'));
      assert.deepEqual(
        heartbeatFiles,
        [],
        'a provider-construction failure must not leave a stale heartbeat file for the next run to misreport as an orphaned incident',
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('disposes the heartbeat file when resolveModel throws (e.g. openrouter with no --model)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-setup-fail-'));
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test';

    try {
      await assert.rejects(
        run('do work', {
          cwd,
          provider: 'openrouter',
          quiet: true,
        }),
      );

      const runDir = join(cwd, '.kodr', 'runs');
      const files = await readdir(runDir).catch(() => []);
      const heartbeatFiles = files.filter((f) => f.startsWith('.heartbeat-'));
      assert.deepEqual(heartbeatFiles, []);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('debug logging wiring', () => {
  it('writes a debug sidecar file when --debug is set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-debug-on-'));
    const model = await startTextOnlyModel();

    try {
      await run('do work', {
        cwd,
        baseUrl: model.baseUrl,
        model: 'test',
        quiet: true,
        debug: true,
      });
      // The write is fire-and-forget from within the run -- give the fs a
      // moment before checking (mirrors test/debug-log.test.mjs's own flush).
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runDir = join(cwd, '.kodr', 'runs');
      const files = await readdir(runDir);
      const debugFiles = files.filter((f) => f.endsWith('-debug.jsonl'));
      assert.equal(debugFiles.length, 1);
      const content = await readFile(join(runDir, debugFiles[0]), 'utf8');
      const record = JSON.parse(content.trim().split('\n')[0]);
      assert.match(record.rawResponse, /"content":"done"/);
    } finally {
      await model.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes no debug sidecar file when --debug is not set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-debug-off-'));
    const model = await startTextOnlyModel();

    try {
      await run('do work', {
        cwd,
        baseUrl: model.baseUrl,
        model: 'test',
        quiet: true,
      });

      const runDir = join(cwd, '.kodr', 'runs');
      const files = await readdir(runDir);
      assert.equal(
        files.some((f) => f.endsWith('-debug.jsonl')),
        false,
      );
    } finally {
      await model.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function startTextOnlyModel() {
  const server = createServer((req, res) => {
    if (req.url === '/api/v0/models') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"role":"assistant","content":"done"}}]}\n\n' +
        'data: [DONE]\n\n',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

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

describe('review pass wiring', () => {
  it('attaches no review result when reviewModel is not set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-noreview-'));
    const model = await startFailingModel();
    try {
      const result = await run('do work', {
        cwd,
        noSave: true,
        baseUrl: model.baseUrl,
        model: 'test',
        quiet: true,
      });
      assert.equal(result.review, undefined);
    } finally {
      await model.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips the model-load step entirely for a provider with no model-lifecycle concept (e.g. OpenRouter)', async () => {
    let loadCalled = false;
    let reviewCalledWithModel;
    const result = await runReviewPass({
      cwd: '/tmp',
      client: { capabilities: { modelLifecycle: false } },
      reviewModel: 'reviewer',
      buildContextWindow: 8192,
      filesChanged: ['a.mjs'],
      quiet: true,
      ensureModelLoadedFn: async () => {
        loadCalled = true;
        return { model: { identifier: 'reviewer' } };
      },
      runReviewFn: async (params) => {
        reviewCalledWithModel = params.modelId;
        return { grounded: true };
      },
    });

    assert.equal(loadCalled, false);
    assert.equal(reviewCalledWithModel, 'reviewer');
    assert.deepEqual(result, { grounded: true });
  });

  it('returns { skipped: true, error } rather than throwing when the model switch fails', async () => {
    const result = await runReviewPass({
      cwd: '/tmp',
      client: { capabilities: { modelLifecycle: true } },
      reviewModel: 'reviewer',
      buildContextWindow: 8192,
      filesChanged: ['a.mjs'],
      quiet: true,
      ensureModelLoadedFn: async () => {
        throw new Error('lms exploded');
      },
      runReviewFn: async () => {
        throw new Error('should not be called -- load already failed');
      },
    });

    assert.equal(result.skipped, true);
    assert.match(result.error, /lms exploded/);
  });

  it('returns { skipped: true, error } rather than throwing when the review itself fails', async () => {
    const result = await runReviewPass({
      cwd: '/tmp',
      client: { capabilities: { modelLifecycle: true } },
      reviewModel: 'reviewer',
      buildContextWindow: 8192,
      filesChanged: ['a.mjs'],
      quiet: true,
      ensureModelLoadedFn: async () => ({ model: { identifier: 'reviewer' } }),
      runReviewFn: async () => {
        throw new Error('review crashed mid-flight');
      },
    });

    assert.equal(result.skipped, true);
    assert.match(result.error, /review crashed mid-flight/);
  });

  it("returns { skipped: true, error } from ensureModelLoaded's own error path, without throwing", async () => {
    const result = await runReviewPass({
      cwd: '/tmp',
      client: { capabilities: { modelLifecycle: true } },
      reviewModel: 'reviewer',
      buildContextWindow: 8192,
      filesChanged: ['a.mjs'],
      quiet: true,
      ensureModelLoadedFn: async () => ({ error: 'reviewer model not found' }),
      runReviewFn: async () => {
        throw new Error('should not be called -- load already failed');
      },
    });

    assert.equal(result.skipped, true);
    assert.match(result.error, /reviewer model not found/);
  });
});

describe('reviewSkippedForIncompleteBuild', () => {
  it('reports skipped: true with the stoppedReason in the message', () => {
    const result = reviewSkippedForIncompleteBuild('error');
    assert.equal(result.skipped, true);
    assert.match(result.reason, /stoppedReason: error/);
  });

  it('reflects whichever stoppedReason it is given', () => {
    assert.match(
      reviewSkippedForIncompleteBuild('tool-limit').reason,
      /tool-limit/,
    );
    assert.match(
      reviewSkippedForIncompleteBuild('budget-exceeded').reason,
      /budget-exceeded/,
    );
  });
});

describe('memory retrospective wiring', () => {
  it('attaches no memory result when --memory is not set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-nomemory-'));
    const model = await startFailingModel();
    try {
      const result = await run('do work', {
        cwd,
        baseUrl: model.baseUrl,
        model: 'test',
        quiet: true,
      });
      assert.equal(result.memory, undefined);
    } finally {
      await model.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('still attempts the retrospective when noSave is set and memory is enabled -- noSave only skips the proposal-file write, not the whole feature', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kodr-nomemory-nosave-'));
    const model = await startFailingModel();
    try {
      const result = await run('do work', {
        cwd,
        noSave: true,
        memory: true,
        baseUrl: model.baseUrl,
        model: 'test',
        quiet: true,
      });
      // The model fails before any tool call, so toolTurns is 0 and the
      // retrospective's own internal check skips it -- but that's a
      // different reason than the gate itself blocking the attempt, which
      // is exactly what this test distinguishes: result.memory is defined
      // (the feature was reached and ran its own logic), not undefined
      // (the feature never got a chance to run at all).
      assert.notEqual(result.memory, undefined);
      assert.equal(result.memory.proposed, false);
    } finally {
      await model.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
