import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTuiReporter } from '../src/tui-reporter.mjs';
import { createTuiState } from '../src/tui-state.mjs';

describe('createTuiReporter', () => {
  it('routes tool calls, notices, and phase changes into the state', () => {
    const state = createTuiState();
    let renders = 0;
    const reporter = createTuiReporter(state, () => {
      renders += 1;
    });

    reporter.phase('build');
    reporter.toolCall({ name: 'read_file', args: { path: 'a.mjs' } });
    reporter.notice('heads up');

    assert.equal(state.phase, 'build');
    assert.equal(state.scrollback.length, 2);
    assert.ok(state.scrollback[0].includes('read_file'));
    assert.ok(state.scrollback[1].includes('heads up'));
    assert.ok(renders >= 3, 'each event requests a render');
  });

  it('accumulates streamed tokens and flushes them on turnEnd', () => {
    const state = createTuiState();
    const reporter = createTuiReporter(state, () => {});
    reporter.token('Hel');
    reporter.token('lo');
    assert.equal(state.stream, 'Hello');
    assert.deepEqual(state.scrollback, []);
    reporter.turnEnd({ completed: true });
    assert.deepEqual(state.scrollback, ['Hello']);
    assert.equal(state.stream, '');
  });

  it('flushes buffered streamed text before a tool-call line', () => {
    const state = createTuiState();
    const reporter = createTuiReporter(state, () => {});
    // A model emits assistant text, then a tool call in the same turn --
    // turnEnd never fires for this (non-final) turn, so the toolCall event
    // must flush the buffered stream ahead of its own line.
    reporter.token('let me check');
    reporter.toolCall({ name: 'read_file', args: { path: 'a.mjs' } });

    assert.equal(state.stream, '', 'stream is flushed, not left pending');
    assert.equal(state.scrollback.length, 2);
    assert.equal(
      state.scrollback[0],
      'let me check',
      'streamed text comes first',
    );
    assert.ok(
      state.scrollback[1].includes('read_file'),
      'tool call line comes after',
    );
  });

  it('renders Markdown in streamed assistant text when it flushes', () => {
    const state = createTuiState();
    const reporter = createTuiReporter(state, () => {});
    reporter.token('see **bold** now');
    reporter.turnEnd({ completed: true });
    assert.ok(state.scrollback[0].includes('\x1b[1m'), 'bold applied');
    assert.ok(state.scrollback[0].includes('bold'));
    assert.ok(!state.scrollback[0].includes('**'), 'markers consumed');
  });

  it('shows an identical notice only once per session', () => {
    const state = createTuiState();
    const reporter = createTuiReporter(state, () => {});
    reporter.notice('context window 131072 tokens');
    reporter.notice('context window 131072 tokens');
    reporter.notice('a distinct notice');
    assert.equal(state.scrollback.length, 2);
    assert.ok(state.scrollback[0].includes('context window 131072'));
    assert.ok(state.scrollback[1].includes('a distinct notice'));
  });

  it('applies summary usage to the header totals', () => {
    const state = createTuiState();
    const reporter = createTuiReporter(state, () => {});
    reporter.summary({
      stoppedReason: 'complete',
      filesChanged: [],
      usage: { prompt: 100, completion: 20, cost: 0 },
    });
    assert.equal(state.tokensIn, 100);
    assert.equal(state.tokensOut, 20);
  });

  it('plan pushes the plan lines into scrollback', () => {
    const state = createTuiState();
    const reporter = createTuiReporter(state, () => {});
    reporter.plan({
      steps: [
        { id: 1, title: 'Set up' },
        { id: 2, title: 'Deploy' },
      ],
      degraded: false,
    });
    const text = state.scrollback.join('\n');
    assert.ok(text.includes('2 steps'));
    assert.ok(text.includes('Set up'));
    assert.ok(text.includes('Deploy'));
  });

  it('stepUpdate sets the header step on running and phase clears it', () => {
    const state = createTuiState();
    const reporter = createTuiReporter(state, () => {});

    reporter.stepUpdate({
      id: 1,
      total: 2,
      title: 'Set up',
      status: 'running',
    });
    assert.deepEqual(state.step, { id: 1, total: 2, title: 'Set up' });
    assert.ok(state.scrollback.some((l) => l.includes('1/2')));

    reporter.stepUpdate({ id: 1, total: 2, title: 'Set up', status: 'done' });
    assert.deepEqual(
      state.step,
      { id: 1, total: 2, title: 'Set up' },
      'a done transition keeps the last step until the next one starts',
    );

    reporter.phase('verify');
    assert.equal(state.step, null, 'a phase transition ends step context');
  });
});
