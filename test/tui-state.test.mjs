import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addToken,
  applyUsage,
  backspace,
  clearApproval,
  createTuiState,
  cursorEnd,
  cursorHome,
  dequeue,
  enqueue,
  flushStream,
  insertChar,
  moveCursor,
  noteOnce,
  pushLine,
  setApproval,
  setPhase,
  setRunning,
  takeInput,
} from '../src/tui-state.mjs';

describe('tui-state', () => {
  it('starts idle with empty scrollback and input', () => {
    const state = createTuiState({ model: 'm' });
    assert.equal(state.status, 'idle');
    assert.equal(state.running, false);
    assert.deepEqual(state.scrollback, []);
    assert.equal(state.input, '');
    assert.equal(state.cursor, 0);
    assert.equal(state.model, 'm');
  });

  it('pushLine appends a logical line', () => {
    const state = createTuiState();
    pushLine(state, 'one');
    pushLine(state, 'two');
    assert.deepEqual(state.scrollback, ['one', 'two']);
  });

  it('addToken accumulates and flushStream moves it into scrollback as lines', () => {
    const state = createTuiState();
    addToken(state, 'line1\nlin');
    addToken(state, 'e2');
    assert.equal(state.stream, 'line1\nline2');
    flushStream(state);
    assert.deepEqual(state.scrollback, ['line1', 'line2']);
    assert.equal(state.stream, '');
  });

  it('setPhase updates the current phase', () => {
    const state = createTuiState();
    setPhase(state, 'verify');
    assert.equal(state.phase, 'verify');
  });

  it('setRunning stamps the start time and status', () => {
    const state = createTuiState();
    setRunning(state, true, 1000);
    assert.equal(state.running, true);
    assert.equal(state.runStartedAt, 1000);
    assert.equal(state.status, 'running');
    setRunning(state, false, 2000);
    assert.equal(state.running, false);
    assert.equal(state.runStartedAt, null);
    assert.equal(state.status, 'idle');
  });

  it('applyUsage adds tokens and cost from a summary', () => {
    const state = createTuiState();
    applyUsage(state, { prompt: 10, completion: 5, cost: 0.01 });
    applyUsage(state, { prompt: 3, completion: 2 });
    assert.equal(state.tokensIn, 13);
    assert.equal(state.tokensOut, 7);
    assert.equal(state.cost, 0.01);
  });

  it('insert adds a character at the cursor and advances it', () => {
    const state = createTuiState();
    insertChar(state, 'a');
    insertChar(state, 'c');
    moveCursor(state, -1);
    insertChar(state, 'b');
    assert.equal(state.input, 'abc');
    assert.equal(state.cursor, 2);
  });

  it('backspace removes the character before the cursor', () => {
    const state = createTuiState();
    for (const ch of 'abc') {
      insertChar(state, ch);
    }
    backspace(state);
    assert.equal(state.input, 'ab');
    assert.equal(state.cursor, 2);
  });

  it('cursor moves clamp at both ends', () => {
    const state = createTuiState();
    for (const ch of 'ab') {
      insertChar(state, ch);
    }
    moveCursor(state, -5);
    assert.equal(state.cursor, 0);
    cursorEnd(state);
    assert.equal(state.cursor, 2);
    moveCursor(state, 5);
    assert.equal(state.cursor, 2);
    cursorHome(state);
    assert.equal(state.cursor, 0);
  });

  it('takeInput returns the buffer and clears it', () => {
    const state = createTuiState();
    for (const ch of 'hi') {
      insertChar(state, ch);
    }
    assert.equal(takeInput(state), 'hi');
    assert.equal(state.input, '');
    assert.equal(state.cursor, 0);
  });

  it('enqueue/dequeue manage the single follow-up slot', () => {
    const state = createTuiState();
    enqueue(state, 'first');
    enqueue(state, 'second');
    assert.equal(state.queued, 'second');
    assert.equal(dequeue(state), 'second');
    assert.equal(state.queued, null);
    assert.equal(dequeue(state), null);
  });

  it('approval mode is set and cleared with the pending command', () => {
    const state = createTuiState();
    setApproval(state, 'rm -rf build');
    assert.deepEqual(state.approval, { command: 'rm -rf build' });
    clearApproval(state);
    assert.equal(state.approval, null);
  });

  it('noteOnce reports a note as new the first time and seen thereafter', () => {
    const state = createTuiState();
    assert.equal(noteOnce(state, 'context window 131072'), true);
    assert.equal(noteOnce(state, 'context window 131072'), false);
    assert.equal(noteOnce(state, 'a different note'), true);
  });
});
