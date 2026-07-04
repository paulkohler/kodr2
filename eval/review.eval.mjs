/**
 * Integration eval — build/review model switch and review pass, end to end.
 *
 * Run with: node --test eval/review.eval.mjs
 * Requires LM Studio running at localhost:1234, the `lms` CLI available,
 * and at least two local models (a build model and a review model).
 *
 * This actually unloads/loads real models via lms -- slow (model loads
 * take tens of seconds each) and disruptive to whatever's currently
 * loaded, so it's an eval, not a unit test.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { run } from '../src/harness.mjs';
import { unloadAllModels } from '../src/lms.mjs';

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

function lmsAvailable() {
  return new Promise((resolve) => {
    execFile('lms', ['ls'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

function localModels() {
  return new Promise((resolve, reject) => {
    execFile('lms', ['ls', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(stdout).map((m) => m.modelKey));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

const lmStudioUp = await lmStudioAvailable();
const lmsUp = await lmsAvailable();
const skipReason =
  (!lmStudioUp && 'LM Studio not available') ||
  (!lmsUp && 'lms CLI not available') ||
  false;

describe('review pass eval', { skip: skipReason }, () => {
  let tmpDir;
  let buildModel;
  let reviewModel;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kodr-review-eval-'));
    const models = await localModels();
    if (models.length < 2) {
      throw new Error(
        `this eval needs at least two local models (lms ls), found ${models.length}`,
      );
    }
    [buildModel, reviewModel] = models;
  });

  after(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    await unloadAllModels();
  });

  it('runs a build then a review on a separate model, end to end', {
    timeout: 300_000,
  }, async () => {
    await writeFile(
      join(tmpDir, 'buggy.mjs'),
      'export function add(a, b) {\n  return a - b; // BUG: should be +\n}\n',
    );

    const result = await run(
      'Read buggy.mjs and fix the bug in the add function. It should add, not subtract.',
      {
        cwd: tmpDir,
        baseUrl: LM_STUDIO_URL,
        model: buildModel,
        reviewModel,
        reviewContextWindow: 8192,
        quiet: true,
        noSave: true,
      },
    );

    assert.equal(result.stoppedReason, 'complete');
    assert.ok(result.review, 'expected a review result to be attached');
    assert.equal(result.review.skipped, false);
    assert.equal(typeof result.review.findings, 'string');
  });
});
