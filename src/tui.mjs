/**
 * The interactive TUI runtime (see specs/tui.yaml) — the imperative shell
 * around the pure state (tui-state.mjs) and rendering (tui-render.mjs).
 *
 * Responsibilities: enter/leave the alternate screen, read raw keypresses,
 * drive one harness run() per turn (queuing follow-ups, never running two at
 * once), surface command-approval prompts, and always restore the terminal --
 * including before incident.mjs's crash-stack write, so a trace isn't lost
 * into the alt buffer.
 */

import { emitKeypressEvents } from 'node:readline';
import { formatNotice } from './format.mjs';
import { run } from './harness.mjs';
import { renderFrame } from './tui-render.mjs';
import { createTuiReporter } from './tui-reporter.mjs';
import {
  backspace,
  clearApproval,
  createTuiState,
  cursorEnd,
  cursorHome,
  dequeue,
  enqueue,
  insertChar,
  moveCursor,
  pushLine,
  setApproval,
  setRunning,
  takeInput,
} from './tui-state.mjs';

const CARET = '\x1b[36m›\x1b[0m';

/**
 * Run the interactive TUI. Resolves when the user quits.
 * @param {string} firstPrompt - Initial prompt (may be empty)
 * @param {import('./harness.mjs').RunOptions} options - The same options run() takes, plus approveCommands
 * @returns {Promise<void>}
 */
export function runTui(firstPrompt, options) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const state = createTuiState({ model: options.model });

  let lastMessages = options.priorMessages || null;
  let busy = false;
  let ticker = null;
  let renderScheduled = false;
  let approvalResolve = null;
  let cleaned = false;
  let resolveSession;

  function draw() {
    const rows = stdout.rows || 24;
    const cols = stdout.columns || 80;
    stdout.write(renderFrameSafe(state, rows, cols));
  }

  function requestRender() {
    if (renderScheduled) {
      return;
    }
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      draw();
    }, 16);
  }

  const reporter = createTuiReporter(state, requestRender);

  function confirm(call) {
    return new Promise((resolve) => {
      approvalResolve = resolve;
      setApproval(state, call.args?.command || JSON.stringify(call.args));
      requestRender();
    });
  }

  function buildRunOptions() {
    return {
      ...options,
      reporter,
      confirm,
      approveCommands: options.approveCommands,
      priorMessages: lastMessages,
      quiet: false,
    };
  }

  async function startRun(prompt) {
    busy = true;
    setRunning(state, true);
    pushLine(state, `${CARET} ${prompt}`);
    requestRender();
    ticker = setInterval(requestRender, 1000);
    try {
      const result = await run(prompt, buildRunOptions());
      lastMessages = result.messages;
      if (result.metadata?.model) {
        state.model = result.metadata.model;
      }
    } catch (err) {
      pushLine(state, formatNotice(`run failed: ${err.message}`));
    } finally {
      clearInterval(ticker);
      ticker = null;
      busy = false;
      setRunning(state, false);
      requestRender();
      const queued = dequeue(state);
      if (queued) {
        startRun(queued);
      }
    }
  }

  function submit(prompt) {
    if (busy) {
      enqueue(state, prompt);
      requestRender();
      return;
    }
    startRun(prompt);
  }

  function resolveApproval(approved) {
    if (!approvalResolve) {
      return;
    }
    const resolve = approvalResolve;
    approvalResolve = null;
    clearApproval(state);
    requestRender();
    resolve({ approved });
  }

  function onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') {
      quit();
      return;
    }
    if (state.approval) {
      handleApprovalKey(str, key);
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const prompt = takeInput(state).trim();
      requestRender();
      if (prompt) {
        submit(prompt);
      }
      return;
    }
    handleEditKey(str, key);
  }

  function handleApprovalKey(str, key) {
    if (str === 'y' || str === 'Y') {
      resolveApproval(true);
      return;
    }
    if (
      str === 'n' ||
      str === 'N' ||
      key.name === 'return' ||
      key.name === 'escape'
    ) {
      resolveApproval(false);
    }
  }

  function handleEditKey(str, key) {
    if (key.name === 'backspace') {
      backspace(state);
    } else if (key.name === 'left') {
      moveCursor(state, -1);
    } else if (key.name === 'right') {
      moveCursor(state, 1);
    } else if (key.name === 'home') {
      cursorHome(state);
    } else if (key.name === 'end') {
      cursorEnd(state);
    } else if (isPrintable(str, key)) {
      insertChar(state, str);
    } else {
      return;
    }
    requestRender();
  }

  function cleanup() {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (ticker) {
      clearInterval(ticker);
    }
    // Settle a pending command approval as denied, so an in-flight run()'s
    // confirm() promise resolves instead of hanging when we tear down (e.g.
    // Ctrl-C) mid-prompt. Resolve directly, not via resolveApproval(), which
    // would touch state/render after we've left the alternate screen.
    if (approvalResolve) {
      const resolve = approvalResolve;
      approvalResolve = null;
      resolve({ approved: false });
    }
    stdin.removeListener('keypress', onKey);
    stdout.removeListener('resize', requestRender);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    stdin.pause();
    // Show cursor, reset scroll region, leave the alternate screen.
    stdout.write('\x1b[?25h\x1b[r\x1b[?1049l');
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('exit', cleanup);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
  }

  function quit() {
    cleanup();
    if (resolveSession) {
      resolveSession();
    }
  }

  function onTerm() {
    cleanup();
    process.exit(143);
  }

  // Registered before any run() (which installs incident.mjs's handlers), so
  // this runs first and leaves the alt screen before a crash stack is written.
  // Only exits when no incident handler is active (idle in the TUI); otherwise
  // incident's own handler logs the stack and exits.
  function onFatal(err) {
    cleanup();
    if (process.listenerCount('uncaughtException') <= 1) {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exit(1);
    }
  }

  emitKeypressEvents(stdin);
  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on('keypress', onKey);
  stdout.on('resize', requestRender);
  process.once('SIGTERM', onTerm);
  process.on('exit', cleanup);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);

  stdout.write('\x1b[?1049h\x1b[?25l');
  draw();

  if (firstPrompt?.trim()) {
    submit(firstPrompt.trim());
  }

  return new Promise((resolve) => {
    resolveSession = resolve;
  });
}

function isPrintable(str, key) {
  return Boolean(str) && !key.ctrl && !key.meta && str.codePointAt(0) >= 0x20;
}

// renderFrame is pure, but a render bug shouldn't take the whole session down
// mid-run and leave the terminal wedged in the alt screen.
function renderFrameSafe(state, rows, cols) {
  try {
    return renderFrame(state, { rows, cols });
  } catch {
    return '';
  }
}
