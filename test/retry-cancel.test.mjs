import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runGoal } from '../src/goal.mjs';
import { runLoop } from '../src/loop.mjs';
import { createNullReporter } from '../src/reporter.mjs';
import { waitForRetry } from '../src/retry-wait.mjs';

it('clears the retry timer and abort listener when cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let completed = false;
  const waiting = waitForRetry(60_000, controller.signal).then(() => {
    completed = true;
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await waiting;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(completed, true);
  t.mock.timers.tick(60_000);
  assert.equal(completed, true);
});

for (const kind of ['plain', 'goal']) {
  it(`cancels a ${kind} retry wait without another build or ratchet`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let builds = 0;
    let completed = false;
    let backingOff = false;
    const reporter = {
      ...createNullReporter(),
      notice: (text) => {
        if (text.includes('backing off')) {
          backingOff = true;
        }
      },
    };
    const build = async () => {
      builds += 1;
      return {
        stoppedReason: 'error',
        filesChanged: ['partial.mjs'],
        messages: [],
        usage: { prompt: 10, completion: 5, cost: 0 },
        retries: 0,
      };
    };
    const forbidden = async () => {
      throw new Error('no work after cancellation');
    };
    const params = {
      signal: controller.signal,
      retryBackoffMs: 60_000,
      maxAttempts: 3,
      reporter,
    };
    let operation;
    if (kind === 'goal') {
      operation = runGoal({
        ...params,
        goal: 'g',
        runTask: build,
        evaluate: forbidden,
      });
    } else {
      operation = runLoop({
        ...params,
        checklist: { nextTask: async () => 'g', markTask: forbidden },
        buildTask: build,
        buildGoal: forbidden,
        git: { park: forbidden, commitGreen: forbidden },
      });
    }
    const pending = operation.then((result) => {
      completed = true;
      return result;
    });
    await setImmediate();
    assert.equal(backingOff, true);
    controller.abort();
    await setImmediate();
    // Observe completion before advancing time, so a non-abortable wait fails.
    assert.equal(completed, true);
    t.mock.timers.tick(60_000);
    const result = await pending;
    assert.equal(result.reason, 'cancelled');
    assert.equal(builds, 1);
    assert.equal(result.usage.prompt, 10);
    if (kind === 'plain') {
      assert.equal(result.tasks[0].status, 'cancelled');
    }
  });
}

it('starts no task when the checklist loop is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const forbidden = async () => {
    throw new Error('no work after cancellation');
  };
  const result = await runLoop({
    signal: controller.signal,
    checklist: { nextTask: forbidden, markTask: forbidden },
    buildTask: forbidden,
    buildGoal: forbidden,
    git: { park: forbidden, commitGreen: forbidden },
  });
  assert.equal(result.reason, 'cancelled');
  assert.deepEqual(result.tasks, []);
});

it('preserves a completed build when cancellation arrives before its mark', async () => {
  const controller = new AbortController();
  const forbidden = async () => {
    throw new Error('cancelled work must not be marked, committed or rewound');
  };
  const result = await runLoop({
    signal: controller.signal,
    checklist: { nextTask: async () => 'g', markTask: forbidden },
    buildTask: async () => {
      controller.abort();
      return {
        stoppedReason: 'complete',
        verification: { passed: true },
        filesChanged: ['partial.mjs'],
        messages: [],
        usage: { prompt: 10, completion: 5, cost: 0 },
        retries: 0,
      };
    },
    buildGoal: forbidden,
    git: { park: forbidden, commitGreen: forbidden },
  });
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.tasks[0].status, 'cancelled');
  assert.equal(result.tasks[0].stoppedReason, 'complete');
});

it('checks cancellation between tasks before selecting another item', async () => {
  const controller = new AbortController();
  let reads = 0;
  const result = await runLoop({
    signal: controller.signal,
    checklist: {
      nextTask: async () => {
        reads += 1;
        return 'g';
      },
      markTask: async () => ({ ok: true }),
    },
    buildTask: async () => ({
      stoppedReason: 'complete',
      verification: { passed: true },
      filesChanged: ['done.mjs'],
      messages: [],
      usage: { prompt: 10, completion: 5, cost: 0 },
      retries: 0,
    }),
    buildGoal: async () => {
      throw new Error('unused');
    },
    git: {
      park: async () => {
        throw new Error('unused');
      },
      commitGreen: async () => ({ ok: true, sha: 'saved' }),
    },
    onRecord: () => {
      controller.abort();
    },
  });
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.green, 1);
  assert.equal(reads, 1);
});
