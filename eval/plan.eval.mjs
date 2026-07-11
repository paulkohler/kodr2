/**
 * Integration eval — planning phase, end to end against LM Studio.
 *
 * Run with: node --test eval/plan.eval.mjs
 * Requires LM Studio running at localhost:1234 with a model loaded.
 *
 * Slow (a planner call plus one sub-agent conversation per step) and
 * non-deterministic (the plan's shape varies by model). Track pass
 * rates, not binary pass/fail.
 */

import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { run } from '../src/harness.mjs';

const LM_STUDIO_URL = 'http://localhost:1234/v1';

function lmStudioAvailable() {
  return new Promise((resolve) => {
    const req = request(`${LM_STUDIO_URL}/models`, { timeout: 3000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('planning phase eval', {
  skip: !(await lmStudioAvailable()) && 'LM Studio not available',
}, () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kodr-plan-eval-'));
  });

  after(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('decomposes a multi-part prompt and completes every step', {
    timeout: 600_000,
  }, async () => {
    const result = await run(
      'Build a tiny Node project in three parts: ' +
        '(1) create src/math.mjs exporting add(a, b) and multiply(a, b), ' +
        '(2) create test/math.test.mjs covering both functions with node:test, ' +
        '(3) create a README.md documenting how to use and test the module.',
      {
        cwd: tmpDir,
        baseUrl: LM_STUDIO_URL,
        quiet: true,
        noSave: true,
        plan: true,
        maxRunMs: 540_000,
      },
    );

    assert.ok(result.plan, 'result carries the plan');
    assert.ok(
      result.plan.steps.length >= 2,
      `a multi-part prompt should yield >= 2 steps (got ${result.plan.steps.length}${result.plan.degraded ? ', degraded' : ''})`,
    );
    assert.ok(
      result.plan.steps.every((step) => step.status === 'done'),
      `every step should complete (got ${result.plan.steps.map((s) => s.status).join(', ')})`,
    );
    assert.equal(result.stoppedReason, 'complete');

    assert.ok(await exists(join(tmpDir, 'src/math.mjs')), 'src/math.mjs');
    assert.ok(
      await exists(join(tmpDir, 'test/math.test.mjs')),
      'test/math.test.mjs',
    );
    assert.ok(await exists(join(tmpDir, 'README.md')), 'README.md');
  });
});
