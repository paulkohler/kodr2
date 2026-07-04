import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ensureModelLoaded,
  listLoadedModels,
  lmsLoadTtlSec,
  lmsTimeoutMs,
  loadModel,
  unloadAllModels,
} from '../src/lms.mjs';

function fakeRun(responses) {
  const calls = [];
  const run = async (command) => {
    calls.push(command);
    const response = responses.shift();
    if (!response) {
      throw new Error(`fakeRun: no response queued for "${command}"`);
    }
    return response;
  };
  run.calls = calls;
  return run;
}

// Matches the real contract of shell.mjs's runShell: { stdout, stderr, exitCode }.
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ exitCode: 1, stdout: '', stderr });

describe('unloadAllModels', () => {
  it('runs "lms unload --all" and returns {} on success', async () => {
    const run = fakeRun([ok()]);
    const result = await unloadAllModels({ run });
    assert.deepEqual(result, {});
    assert.equal(run.calls[0], "lms 'unload' '--all'");
  });

  it('returns an error when the command exits non-zero', async () => {
    const run = fakeRun([fail('lms: no such command')]);
    const result = await unloadAllModels({ run });
    assert.match(result.error, /lms unload --all failed/);
    assert.match(result.error, /no such command/);
  });
});

describe('loadModel', () => {
  it('runs lms load with the model, context length, ttl, and identifier', async () => {
    const run = fakeRun([ok()]);
    await loadModel({
      model: 'qwen/test',
      contextWindow: 131072,
      ttlSec: 60,
      run,
    });
    assert.equal(
      run.calls[0],
      "lms 'load' 'qwen/test' '--gpu' 'max' '--ttl' '60' '--identifier' 'qwen/test' '-y' '-c' '131072'",
    );
  });

  it('omits -c when contextWindow is not given', async () => {
    const run = fakeRun([ok()]);
    await loadModel({ model: 'qwen/test', run });
    assert.ok(!run.calls[0].includes("'-c'"));
  });

  it('returns an error when the command exits non-zero', async () => {
    const run = fakeRun([fail('model not found')]);
    const result = await loadModel({ model: 'qwen/test', run });
    assert.match(result.error, /lms load qwen\/test failed/);
    assert.match(result.error, /model not found/);
  });
});

describe('listLoadedModels', () => {
  it('parses lms ps --json output into an array', async () => {
    const run = fakeRun([
      ok(JSON.stringify([{ identifier: 'qwen/test', contextLength: 8192 }])),
    ]);
    const result = await listLoadedModels({ run });
    assert.deepEqual(result.models, [
      { identifier: 'qwen/test', contextLength: 8192 },
    ]);
  });

  it("returns an error when output isn't valid JSON", async () => {
    const run = fakeRun([ok('not json')]);
    const result = await listLoadedModels({ run });
    assert.match(result.error, /unparseable output/);
  });

  it('returns an error when the command exits non-zero', async () => {
    const run = fakeRun([fail('lms: command not found')]);
    const result = await listLoadedModels({ run });
    assert.match(result.error, /lms ps failed/);
  });
});

describe('ensureModelLoaded', () => {
  it('returns the matching model when identifier and contextLength match', async () => {
    const run = fakeRun([
      ok(), // unload
      ok(), // load
      ok(JSON.stringify([{ identifier: 'qwen/test', contextLength: 131072 }])), // ps
    ]);
    const result = await ensureModelLoaded({
      model: 'qwen/test',
      contextWindow: 131072,
      run,
    });
    assert.deepEqual(result, {
      model: { identifier: 'qwen/test', contextLength: 131072 },
    });
  });

  it("returns an error when the requested model isn't in lms ps afterward", async () => {
    const run = fakeRun([
      ok(),
      ok(),
      ok(
        JSON.stringify([
          { identifier: 'some/other-model', contextLength: 131072 },
        ]),
      ),
    ]);
    const result = await ensureModelLoaded({ model: 'qwen/test', run });
    assert.match(result.error, /not in lms ps/);
  });

  it("returns an error when the loaded contextLength doesn't match the request", async () => {
    const run = fakeRun([
      ok(),
      ok(),
      ok(JSON.stringify([{ identifier: 'qwen/test', contextLength: 8192 }])),
    ]);
    const result = await ensureModelLoaded({
      model: 'qwen/test',
      contextWindow: 131072,
      run,
    });
    assert.match(result.error, /loaded at context 8192, expected 131072/);
  });

  it('skips the contextLength check when contextWindow is 0 or omitted', async () => {
    const run = fakeRun([
      ok(),
      ok(),
      ok(JSON.stringify([{ identifier: 'qwen/test', contextLength: 8192 }])),
    ]);
    const result = await ensureModelLoaded({ model: 'qwen/test', run });
    assert.equal(result.error, undefined);
    assert.equal(result.model.identifier, 'qwen/test');
  });

  it('stops and returns the error if unload fails, without attempting to load', async () => {
    const run = fakeRun([fail('unload failed')]);
    const result = await ensureModelLoaded({ model: 'qwen/test', run });
    assert.match(result.error, /unload/);
    assert.equal(run.calls.length, 1);
  });

  it('stops and returns the error if load fails, without attempting to verify', async () => {
    const run = fakeRun([ok(), fail('load failed')]);
    const result = await ensureModelLoaded({ model: 'qwen/test', run });
    assert.match(result.error, /load/);
    assert.equal(run.calls.length, 2);
  });
});

describe('lmsTimeoutMs', () => {
  it('prefers an explicit option', () => {
    assert.equal(lmsTimeoutMs(5000), 5000);
  });

  it('falls back to the default when nothing is set', () => {
    delete process.env.KODR_LMS_TIMEOUT_MS;
    assert.equal(lmsTimeoutMs(undefined), 120_000);
  });
});

describe('lmsLoadTtlSec', () => {
  it('prefers an explicit option', () => {
    assert.equal(lmsLoadTtlSec(30), 30);
  });

  it('falls back to the default when nothing is set', () => {
    delete process.env.KODR_LMS_TTL_SEC;
    assert.equal(lmsLoadTtlSec(undefined), 600);
  });
});
