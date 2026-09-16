import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEvalTraceReporter,
  median,
  positiveIntEnv,
  runWithAbortBudget,
  summarizeAttempts,
} from '../eval/support/compaction-eval.mjs';

describe('compaction eval support', () => {
  it('records bounded tool and compaction diagnostics without result content', () => {
    const { reporter, events } = createEvalTraceReporter({
      maxEvents: 4,
      maxFieldChars: 20,
    });

    reporter.toolCall({
      name: 'read_file',
      args: { path: `large-${'x'.repeat(30)}.txt` },
    });
    reporter.toolResult({
      name: 'read_file',
      result: { content: 'secret'.repeat(100), truncated: true },
    });
    reporter.compaction({ promptTokens: 7000, limit: 6554 });

    assert.equal(events.length, 3);
    assert.match(Reflect.get(events[0], 'args'), /truncated/);
    assert.deepEqual(events[1], {
      event: 'tool.result',
      name: 'read_file',
      keys: ['content', 'truncated'],
      error: null,
      contentChars: 600,
    });
    assert.equal(JSON.stringify(events).includes('secretsecret'), false);
    assert.deepEqual(events[2], {
      event: 'compaction',
      promptTokens: 7000,
      limit: 6554,
    });
  });

  it('keeps the newest events when the trace reaches its cap', () => {
    const { reporter, events } = createEvalTraceReporter({ maxEvents: 2 });

    reporter.compaction({ promptTokens: 1, limit: 10 });
    reporter.compaction({ promptTokens: 2, limit: 10 });
    reporter.compaction({ promptTokens: 3, limit: 10 });

    assert.deepEqual(
      events.map((event) => Reflect.get(event, 'promptTokens')),
      [2, 3],
    );
  });

  it('accepts positive integer environment values', () => {
    assert.equal(positiveIntEnv('3', 1), 3);
    assert.equal(positiveIntEnv(undefined, 2), 2);
    assert.equal(positiveIntEnv('0', 2), 2);
    assert.equal(positiveIntEnv('-1', 2), 2);
    assert.equal(positiveIntEnv('1.5', 2), 2);
  });

  it('calculates odd and even medians without changing the input', () => {
    const values = [9, 1, 5, 3];

    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median(values), 4);
    assert.equal(median([]), null);
    assert.deepEqual(values, [9, 1, 5, 3]);
  });

  it('summarizes pass rate and median metrics', () => {
    const summary = summarizeAttempts([
      {
        passed: true,
        durationMs: 100,
        promptTokens: 300,
        completionTokens: 20,
        compactions: 1,
      },
      {
        passed: false,
        durationMs: 200,
        promptTokens: 500,
        completionTokens: 40,
        compactions: 3,
      },
    ]);

    assert.deepEqual(summary, {
      attempts: 2,
      passed: 1,
      passRate: 0.5,
      medianDurationMs: 150,
      medianPromptTokens: 400,
      medianCompletionTokens: 30,
      medianCompactions: 2,
    });
  });

  it('aborts at the budget and allows the attempt to settle', async () => {
    const measured = await runWithAbortBudget(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('cancelled'), {
            once: true,
          });
        }),
      { budgetMs: 10, graceMs: 100 },
    );

    assert.equal(measured.value, 'cancelled');
    assert.equal(measured.timedOut, true);
    assert.ok(measured.durationMs >= 10);
  });
});
