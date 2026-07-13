import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAcpReporter } from '../src/acp-reporter.mjs';
import { REPORTER_METHODS } from '../src/reporter.mjs';

function setup() {
  const updates = [];
  const turnState = { toolCallId: null };
  const reporter = createAcpReporter((u) => updates.push(u), turnState);
  return { reporter, updates, turnState };
}

describe('createAcpReporter', () => {
  it('is total over REPORTER_METHODS', () => {
    const { reporter } = setup();
    for (const name of REPORTER_METHODS) {
      assert.equal(typeof reporter[name], 'function', name);
    }
  });

  it('token emits an agent_message_chunk and skips empty deltas', () => {
    const { reporter, updates } = setup();
    reporter.token('hello');
    reporter.token('');
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
  });

  it('toolCall/toolResult emit paired tool_call and tool_call_update with one id', () => {
    const { reporter, updates, turnState } = setup();
    reporter.toolCall({ name: 'write_file', args: { path: 'a.txt' } });
    reporter.toolResult({ name: 'write_file', result: { content: 'ok' } });

    assert.equal(updates[0].sessionUpdate, 'tool_call');
    assert.equal(updates[0].title, 'write_file');
    assert.equal(updates[0].kind, 'edit');
    assert.equal(updates[0].status, 'pending');
    assert.deepEqual(updates[0].rawInput, { path: 'a.txt' });

    assert.equal(updates[1].sessionUpdate, 'tool_call_update');
    assert.equal(updates[1].toolCallId, updates[0].toolCallId);
    assert.equal(updates[1].status, 'completed');
    // The shared turn state points at the streamed call, for the confirm channel.
    assert.equal(turnState.toolCallId, updates[0].toolCallId);
  });

  it('marks a tool result with an error as failed', () => {
    const { reporter, updates } = setup();
    reporter.toolCall({ name: 'run_command', args: { command: 'nope' } });
    reporter.toolResult({ name: 'run_command', result: { error: 'boom' } });
    assert.equal(updates[1].status, 'failed');
  });

  it('phase emits an accumulating plan marking the current phase in_progress', () => {
    const { reporter, updates } = setup();
    reporter.phase('build');
    reporter.phase('verify');

    assert.equal(updates[0].sessionUpdate, 'plan');
    assert.deepEqual(
      updates[0].entries.map((e) => [e.content, e.status]),
      [['build', 'in_progress']],
    );
    assert.deepEqual(
      updates[1].entries.map((e) => [e.content, e.status]),
      [
        ['build', 'completed'],
        ['verify', 'in_progress'],
      ],
    );
  });

  it('leaves unmapped methods as silent no-ops', () => {
    const { reporter, updates } = setup();
    reporter.notice('hi');
    reporter.heartbeat({ label: 'model', elapsedMs: 10 });
    reporter.verification({ passed: true, output: '', command: 'x' });
    reporter.summary({ stoppedReason: 'complete' });
    reporter.turnEnd({ completed: true });
    assert.equal(updates.length, 0);
  });
});
