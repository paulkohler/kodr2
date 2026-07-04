import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasNoProgress, heal } from '../src/heal.mjs';

describe('healing', () => {
  it('detects identical consecutive failures as no progress', () => {
    assert.equal(hasNoProgress('same failure', 'same failure'), true);
    assert.equal(hasNoProgress('first failure', 'second failure'), false);
  });

  it('treats timing-only differences as no progress', () => {
    const a = '1 failing\n  duration_ms: 12.4\n  at foo.mjs:5';
    const b = '1 failing\n  duration_ms: 88.1\n  at foo.mjs:5';
    assert.equal(hasNoProgress(a, b), true);
  });

  it('treats different failure locations as progress', () => {
    const a = 'AssertionError at foo.mjs:5';
    const b = 'AssertionError at foo.mjs:9';
    assert.equal(hasNoProgress(a, b), false);
  });

  it('respects a zero-turn limit without calling the model', async () => {
    let modelCalled = false;
    const client = {
      async chat() {
        modelCalled = true;
        throw new Error('model must not be called');
      },
    };
    const verification = { passed: false, output: 'failure' };
    const result = await heal({
      client,
      modelId: 'unused',
      messages: [],
      tools: {},
      verifyFn: async () => verification,
      failure: verification,
      maxTurns: 0,
      quiet: true,
    });

    assert.equal(modelCalled, false);
    assert.equal(result.turns, 0);
    assert.equal(result.healed, false);
  });

  it('forwards heartbeatMs and onHeartbeat to the model client', async () => {
    const calls = [];
    const client = {
      async chat(params) {
        calls.push(params);
        return {
          message: { role: 'assistant', content: 'fixed' },
          usage: { prompt: 1, completion: 1 },
        };
      },
    };
    const verification = { passed: false, output: 'failure' };
    const onHeartbeat = () => {};
    await heal({
      client,
      modelId: 'unused',
      messages: [],
      tools: { definitions: () => [] },
      verifyFn: async () => ({ passed: true, output: '' }),
      failure: verification,
      maxTurns: 1,
      quiet: true,
      heartbeatMs: 5000,
      onHeartbeat,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].heartbeatMs, 5000);
    assert.equal(calls[0].onHeartbeat, onHeartbeat);
  });

  it("sums the tool loop's retries into the heal result", async () => {
    const client = {
      async chat() {
        return {
          message: { role: 'assistant', content: 'fixed' },
          usage: { prompt: 1, completion: 1 },
          retries: 2,
        };
      },
    };
    const verification = { passed: false, output: 'failure' };
    const result = await heal({
      client,
      modelId: 'unused',
      messages: [],
      tools: { definitions: () => [] },
      verifyFn: async () => ({ passed: true, output: '' }),
      failure: verification,
      maxTurns: 1,
      quiet: true,
    });

    assert.equal(result.retries, 2);
  });
});
