import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatHealTurn,
  formatHeartbeat,
  formatNotice,
  formatPlan,
  formatStepUpdate,
  formatSummary,
  formatToolCall,
  formatToolResult,
  formatVerification,
} from '../src/format.mjs';
import {
  createJsonReporter,
  createNullReporter,
  createTerminalReporter,
  REPORTER_METHODS,
} from '../src/reporter.mjs';
import { createFakeStream } from './capture-reporter.mjs';

describe('createNullReporter', () => {
  it('exposes every REPORTER_METHODS name as a no-op returning undefined', () => {
    const reporter = createNullReporter();
    for (const name of REPORTER_METHODS) {
      assert.equal(typeof reporter[name], 'function', name);
      assert.equal(reporter[name]({ any: 'payload' }), undefined, name);
    }
  });
});

describe('createTerminalReporter', () => {
  function setup() {
    const stdout = createFakeStream();
    const stderr = createFakeStream();
    return {
      reporter: createTerminalReporter({ stdout, stderr }),
      stdout,
      stderr,
    };
  }

  it('token writes the raw text to stdout, unformatted', () => {
    const { reporter, stdout, stderr } = setup();
    reporter.token('hello ');
    reporter.token('world');
    assert.equal(stdout.text(), 'hello world');
    assert.equal(stderr.text(), '');
  });

  it('turnEnd writes exactly one newline to stdout when completed, nothing otherwise', () => {
    const { reporter, stdout } = setup();
    reporter.turnEnd({ completed: false });
    assert.equal(stdout.text(), '');
    reporter.turnEnd({ completed: true });
    assert.equal(stdout.text(), '\n');
  });

  it('phase and toolActivity write nothing to either stream', () => {
    const { reporter, stdout, stderr } = setup();
    reporter.phase('build');
    reporter.toolActivity('read_file');
    assert.equal(stdout.text(), '');
    assert.equal(stderr.text(), '');
  });

  it('chrome methods each write formatX(...)+newline to stderr', () => {
    const { reporter, stderr } = setup();
    const call = { name: 'read_file', args: { path: 'a.mjs' } };
    reporter.toolCall(call);
    reporter.toolResult({ name: 'read_file', result: { content: 'x' } });
    reporter.notice('heads up');
    reporter.heartbeat({ label: 'model response', elapsedMs: 3000 });
    reporter.verification({ passed: true, output: '', command: 'npm test' });
    reporter.healTurn({ turn: 1, max: 3 });
    reporter.summary({
      filesChanged: ['a.mjs'],
      usage: { prompt: 1, completion: 2, cost: 0 },
    });

    assert.equal(
      stderr.text(),
      `${formatToolCall('read_file', { path: 'a.mjs' })}\n` +
        `${formatToolResult('read_file', { content: 'x' })}\n` +
        `${formatNotice('heads up')}\n` +
        `${formatHeartbeat('model response', 3000)}\n` +
        `${formatVerification({ passed: true, output: '', command: 'npm test' })}\n` +
        `${formatHealTurn(1, 3)}\n` +
        `${formatSummary({ filesChanged: ['a.mjs'], usage: { prompt: 1, completion: 2, cost: 0 } })}\n`,
    );
  });

  it('compaction writes the same notice string the inline message produced', () => {
    const { reporter, stderr } = setup();
    reporter.compaction({ promptTokens: 900, limit: 800 });
    assert.equal(
      stderr.text(),
      `${formatNotice('compacting context (900 >= 800 tokens)')}\n`,
    );
  });

  it('plan and stepUpdate write formatX(...)+newline to stderr', () => {
    const { reporter, stderr } = setup();
    const steps = [{ id: 1, title: 'Do it' }];
    const update = { id: 1, total: 1, title: 'Do it', status: 'running' };
    reporter.plan({ steps, degraded: false });
    reporter.stepUpdate(update);
    assert.equal(
      stderr.text(),
      `${formatPlan(steps, false)}\n${formatStepUpdate(update)}\n`,
    );
  });
});

describe('createJsonReporter', () => {
  function lines(stream) {
    return stream
      .text()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('emits one NDJSON object per event tagged with event', () => {
    const out = createFakeStream();
    const reporter = createJsonReporter({ out });
    reporter.toolCall({ name: 'read_file', args: { path: 'a.mjs' } });
    reporter.notice('hi');
    const parsed = lines(out);
    assert.deepEqual(parsed, [
      { event: 'tool.call', name: 'read_file', args: { path: 'a.mjs' } },
      { event: 'notice', text: 'hi' },
    ]);
  });

  it('coalesces consecutive tokens into a single assistant_text flushed on the next non-token event', () => {
    const out = createFakeStream();
    const reporter = createJsonReporter({ out });
    reporter.token('Hel');
    reporter.token('lo');
    // Nothing emitted yet — tokens are buffered.
    assert.equal(out.text(), '');
    reporter.toolCall({ name: 'read_file', args: {} });
    const parsed = lines(out);
    assert.deepEqual(parsed[0], { event: 'assistant_text', text: 'Hello' });
    assert.equal(parsed[1].event, 'tool.call');
  });

  it('summary emits stoppedReason, filesChanged, and usage', () => {
    const out = createFakeStream();
    const reporter = createJsonReporter({ out });
    reporter.summary(
      /** @type {any} */ ({
        stoppedReason: 'complete',
        filesChanged: ['a.mjs'],
        usage: { prompt: 1, completion: 2, cost: 0 },
        messages: [{ role: 'user', content: 'huge' }],
      }),
    );
    const [event] = lines(out);
    assert.deepEqual(event, {
      event: 'summary',
      stoppedReason: 'complete',
      filesChanged: ['a.mjs'],
      usage: { prompt: 1, completion: 2, cost: 0 },
    });
  });

  it('plan emits step ids and titles only, never descriptions', () => {
    const out = createFakeStream();
    const reporter = createJsonReporter({ out });
    reporter.plan({
      steps: /** @type {any} */ ([
        { id: 1, title: 'Do it', description: 'kilobytes of detail' },
      ]),
      degraded: true,
    });
    const [event] = lines(out);
    assert.deepEqual(event, {
      event: 'plan',
      steps: [{ id: 1, title: 'Do it' }],
      degraded: true,
    });
  });

  it('stepUpdate emits a step.update event with the transition', () => {
    const out = createFakeStream();
    const reporter = createJsonReporter({ out });
    reporter.stepUpdate({
      id: 2,
      total: 3,
      title: 'Write hook',
      status: 'failed',
      stoppedReason: 'tool-limit',
      summary: 'ran out of turns',
    });
    const [event] = lines(out);
    assert.deepEqual(event, {
      event: 'step.update',
      id: 2,
      total: 3,
      title: 'Write hook',
      status: 'failed',
      stoppedReason: 'tool-limit',
      summary: 'ran out of turns',
    });
  });
});
