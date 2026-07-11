/**
 * TUI render state and its mutators — pure data, no I/O.
 *
 * src/tui.mjs (the imperative shell) and src/tui-reporter.mjs mutate this
 * object; src/tui-render.mjs reads it to build a frame. Keeping it pure makes
 * the interesting logic (scrollback, streaming, input editing, the follow-up
 * queue, approval mode) unit-testable without a terminal.
 */

/**
 * @typedef {object} TuiState
 * @property {string} model
 * @property {string} phase
 * @property {{ id: number, total: number, title: string }|null} step
 * @property {string} status
 * @property {string[]} scrollback
 * @property {string} stream
 * @property {string} input
 * @property {number} cursor
 * @property {string|null} queued
 * @property {{ command: string }|null} approval
 * @property {boolean} running
 * @property {number|null} runStartedAt
 * @property {number} tokensIn
 * @property {number} tokensOut
 * @property {number} cost
 * @property {Set<string>} noticeSeen
 */

/**
 * @param {{ model?: string }} [init]
 * @returns {TuiState} A fresh TUI state.
 */
export function createTuiState(init = {}) {
  return {
    model: init.model || 'model',
    phase: '',
    // The running plan step ({ id, total, title }) while the planned build
    // executes, else null. Rendered as "step i/N" in the header.
    step: null,
    status: 'idle',
    // Scrollback holds logical (unwrapped) lines; wrapping happens at render.
    scrollback: [],
    // In-progress streamed assistant text, not yet flushed into scrollback.
    stream: '',
    input: '',
    cursor: 0,
    queued: null,
    // { command } while awaiting a run_command approval keypress, else null.
    approval: null,
    running: false,
    runStartedAt: null,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    // Notice texts already shown this session, so a note repeated on a later
    // turn (e.g. the context-window notice) isn't reprinted.
    noticeSeen: new Set(),
  };
}

/**
 * Append one logical line to the scrollback.
 * @param {TuiState} state
 * @param {string} line
 */
export function pushLine(state, line) {
  state.scrollback.push(line);
}

/**
 * Accumulate a streamed assistant-text delta (not yet in scrollback).
 * @param {TuiState} state
 * @param {string} text
 */
export function addToken(state, text) {
  state.stream += text;
}

/**
 * Move the in-progress stream into scrollback as one or more logical lines and
 * clear it. A no-op when nothing has streamed. Each line passes through
 * `transform` first (used to render assistant Markdown to ANSI); the default
 * is identity.
 * @param {TuiState} state
 * @param {(line: string) => string} [transform]
 */
export function flushStream(state, transform = (line) => line) {
  if (!state.stream) {
    return;
  }
  for (const line of state.stream.split('\n')) {
    state.scrollback.push(transform(line));
  }
  state.stream = '';
}

/**
 * Set the current run phase (plan/build/verify/heal/review/memory/compact).
 * @param {TuiState} state
 * @param {string} name
 */
export function setPhase(state, name) {
  state.phase = name;
}

/**
 * Set (or clear, with null) the running plan step shown in the header.
 * @param {TuiState} state
 * @param {{ id: number, total: number, title: string }|null} step
 */
export function setStep(state, step) {
  state.step = step;
}

/**
 * Set the short status word shown in the header.
 * @param {TuiState} state
 * @param {string} text
 */
export function setStatus(state, text) {
  state.status = text;
}

/**
 * Mark whether a run is in flight, stamping the start time when it begins.
 * @param {TuiState} state
 * @param {boolean} running
 * @param {number} [now]
 */
export function setRunning(state, running, now = Date.now()) {
  state.running = running;
  if (running) {
    state.runStartedAt = now;
    state.status = 'running';
  } else {
    state.runStartedAt = null;
    state.status = state.queued ? 'queued' : 'idle';
  }
}

/**
 * Add a run's token/cost usage to the running session totals.
 * @param {TuiState} state
 * @param {{ prompt: number, completion: number, cost: number }} usage
 */
export function applyUsage(state, usage) {
  if (!usage) {
    return;
  }
  state.tokensIn += usage.prompt || 0;
  state.tokensOut += usage.completion || 0;
  state.cost += usage.cost || 0;
}

/**
 * Insert a printable character at the cursor.
 * @param {TuiState} state
 * @param {string} ch
 */
export function insertChar(state, ch) {
  state.input =
    state.input.slice(0, state.cursor) + ch + state.input.slice(state.cursor);
  state.cursor += ch.length;
}

/**
 * Delete the character before the cursor (Backspace).
 * @param {TuiState} state
 */
export function backspace(state) {
  if (state.cursor === 0) {
    return;
  }
  state.input =
    state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
  state.cursor -= 1;
}

/**
 * Move the cursor by delta, clamped to the input bounds.
 * @param {TuiState} state
 * @param {number} delta
 */
export function moveCursor(state, delta) {
  state.cursor = clamp(state.cursor + delta, 0, state.input.length);
}

/**
 * Move the cursor to the start of the input.
 * @param {TuiState} state
 */
export function cursorHome(state) {
  state.cursor = 0;
}

/**
 * Move the cursor to the end of the input.
 * @param {TuiState} state
 */
export function cursorEnd(state) {
  state.cursor = state.input.length;
}

/**
 * Return the current input and clear the buffer.
 * @param {TuiState} state
 * @returns {string}
 */
export function takeInput(state) {
  const value = state.input;
  state.input = '';
  state.cursor = 0;
  return value;
}

/**
 * Queue a single follow-up prompt (replacing any already queued).
 * @param {TuiState} state
 * @param {string} prompt
 */
export function enqueue(state, prompt) {
  state.queued = prompt;
  if (state.running) {
    state.status = 'queued';
  }
}

/**
 * Take the queued follow-up, clearing the slot. Returns null when empty.
 * @param {TuiState} state
 * @returns {string|null}
 */
export function dequeue(state) {
  const value = state.queued;
  state.queued = null;
  return value;
}

/**
 * Record a notice text and report whether it is new this session. Returns true
 * the first time a given text is seen, false on every later repeat.
 * @param {TuiState} state
 * @param {string} text
 * @returns {boolean}
 */
export function noteOnce(state, text) {
  if (state.noticeSeen.has(text)) {
    return false;
  }
  state.noticeSeen.add(text);
  return true;
}

/**
 * Enter approval mode for a pending command.
 * @param {TuiState} state
 * @param {string} command
 */
export function setApproval(state, command) {
  state.approval = { command };
}

/**
 * Leave approval mode.
 * @param {TuiState} state
 */
export function clearApproval(state) {
  state.approval = null;
}

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
