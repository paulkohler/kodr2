/**
 * Integration eval — ensureModelLoaded against the real `lms` CLI.
 *
 * Run with: node --test eval/lms.eval.mjs
 * Requires LM Studio's `lms` CLI on PATH and at least one local model
 * available (`lms ls`).
 *
 * Slow (a real model load/unload) and depends on local machine state
 * (available models, GPU memory) rather than model output, so it's an
 * eval, not a unit test.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

import { ensureModelLoaded, unloadAllModels } from '../src/lms.mjs';

function lmsAvailable() {
  return new Promise((resolve) => {
    execFile('lms', ['ls'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

function firstLocalModel() {
  return new Promise((resolve, reject) => {
    execFile('lms', ['ls', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const models = JSON.parse(stdout);
        resolve(models[0]?.modelKey ?? models[0]?.path);
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

describe('lms eval', {
  skip: !(await lmsAvailable()) && 'lms CLI not available',
}, () => {
  let model;

  before(async () => {
    model = await firstLocalModel();
  });

  after(async () => {
    await unloadAllModels();
  });

  it('loads the requested model and verifies it via lms ps', async () => {
    const result = await ensureModelLoaded({ model, contextWindow: 4096 });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.model.identifier, model);
    assert.equal(result.model.contextLength, 4096);
  });
});
