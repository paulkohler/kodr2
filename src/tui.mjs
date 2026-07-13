/**
 * The interactive TUI runtime (see specs/tui.yaml) — the imperative shell
 * around the pure state (tui-state.mjs) and rendering (tui-render.mjs).
 *
 * Responsibilities: enter/leave the alternate screen, read raw keypresses,
 * drive one harness run() per turn (queuing follow-ups, never running two at
 * once), dispatch slash commands (src/tui-commands.mjs), surface
 * command-approval prompts, and always restore the terminal -- including
 * before incident.mjs's crash-stack write, so a trace isn't lost into the alt
 * buffer.
 */

import { emitKeypressEvents } from 'node:readline';
import { formatDoctorReport, formatNotice } from './format.mjs';
import { runDoctorChecks } from './doctor.mjs';
import { run } from './harness.mjs';
import { resolveProviderName } from './provider.mjs';
import { runShell } from './shell.mjs';
import {
  PROMPT_ECHO,
  completeCommand,
  dispatchCommand,
} from './tui-commands.mjs';
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
  setInput,
  setQuitPending,
  setRunning,
  takeInput,
} from './tui-state.mjs';

const CARET = PROMPT_ECHO;

// How long a first Ctrl-C waits for a confirming second press before standing
// down. Overridable per session via options.quitConfirmMs.
const QUIT_CONFIRM_MS = 3000;

/**
 * TUI options: everything run() takes, plus TUI-only settings consumed here and
 * never forwarded to run(). stdin/stdout default to the process streams and are
 * injected only by the in-process driver test (test/tui-driver.test.mjs).
 * @typedef {import('./harness.mjs').RunOptions & {
 *   quitConfirmMs?: number,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 * }} TuiOptions
 */

/**
 * Run the interactive TUI. Resolves when the user quits.
 * @param {string} firstPrompt - Initial prompt (may be empty)
 * @param {TuiOptions} options - The same options run() takes, plus approveCommands and quitConfirmMs
 * @returns {Promise<void>}
 */
export function runTui(firstPrompt, options) {
  // Cast back to the tty stream types: production passes process.stdin/stdout,
  // and the driver test injects streams that duck-type a TTY.
  const stdin = /** @type {import('node:tty').ReadStream} */ (
    options.stdin || process.stdin
  );
  const stdout = /** @type {import('node:tty').WriteStream} */ (
    options.stdout || process.stdout
  );
  const state = createTuiState({ model: options.model });

  let lastMessages = options.priorMessages || null;
  let busy = false;
  let ticker = null;
  let renderScheduled = false;
  let approvalResolve = null;
  let cleaned = false;
  let resolveSession;
  let currentAbort = null;
  let quitTimer = null;
  const quitConfirmMs = options.quitConfirmMs || QUIT_CONFIRM_MS;

  // Live per-session config the slash commands read and mutate (see
  // specs/tui-slash-commands.yaml). buildRunOptions() reads the mutable fields
  // so /model, /test, /approve, and /reasoning take effect on the next turn.
  const session = {
    provider: resolveProviderName(options.provider),
    model: options.model || state.model,
    testCommand: options.testCommand,
    approveCommands: Boolean(options.approveCommands),
    reasoning: Boolean(options.reasoning),
    reasoningSupported: resolveProviderName(options.provider) === 'openrouter',
    contextWindow: options.contextWindow,
    messages: options.priorMessages || [],
    lastPrompt: null,
  };

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
      model: session.model,
      testCommand: session.testCommand,
      reasoning: session.reasoning,
      reporter,
      confirm,
      approveCommands: session.approveCommands,
      priorMessages: lastMessages,
      quiet: false,
      signal: currentAbort.signal,
    };
  }

  async function startRun(prompt) {
    busy = true;
    currentAbort = new AbortController();
    setRunning(state, true);
    pushLine(state, `${CARET} ${prompt}`);
    // Remember the task prompt for /retry (but not the /compact meta-command,
    // which isn't a task to re-run).
    if (prompt !== '/compact') {
      session.lastPrompt = prompt;
    }
    requestRender();
    ticker = setInterval(requestRender, 1000);
    try {
      const result = await run(prompt, buildRunOptions());
      lastMessages = result.messages;
      session.messages = result.messages || [];
      if (result.metadata?.model) {
        state.model = result.metadata.model;
        session.model = result.metadata.model;
      }
    } catch (err) {
      pushLine(state, formatNotice(`run failed: ${err.message}`));
    } finally {
      clearInterval(ticker);
      ticker = null;
      busy = false;
      currentAbort = null;
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

  // Ctrl-C no longer quits on the first press. A first press interrupts an
  // active run (like /stop, settling any pending approval) and arms a quit
  // confirmation; a second press within the window quits -- the escape hatch
  // even mid-run. So a stray Ctrl-C never drops you out of the session.
  function onCtrlC() {
    if (state.quitPending) {
      quit();
      return;
    }
    if (busy) {
      if (approvalResolve) {
        resolveApproval(false);
      }
      if (currentAbort) {
        currentAbort.abort();
      }
    }
    armQuit();
  }

  function armQuit() {
    setQuitPending(state, true);
    requestRender();
    if (quitTimer) {
      clearTimeout(quitTimer);
    }
    quitTimer = setTimeout(standDownQuit, quitConfirmMs);
  }

  function standDownQuit() {
    if (quitTimer) {
      clearTimeout(quitTimer);
      quitTimer = null;
    }
    setQuitPending(state, false);
    requestRender();
  }

  function onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') {
      onCtrlC();
      return;
    }
    // Any other key stands down a pending quit -- you changed your mind.
    if (state.quitPending) {
      standDownQuit();
    }
    if (state.approval) {
      handleApprovalKey(str, key);
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const text = takeInput(state).trim();
      requestRender();
      if (text) {
        submitLine(text);
      }
      return;
    }
    handleEditKey(str, key);
  }

  // A slash command is dispatched locally (immediately, even mid-run, since it
  // acts on the session, not the model); anything else is a prompt for the
  // model -- including an unknown /word, which is never swallowed.
  function submitLine(text) {
    const outcome = dispatchCommand(text, state, session);
    if (!outcome.handled) {
      submit(text);
      return;
    }
    applyEffect(outcome);
    requestRender();
  }

  function applyEffect(outcome) {
    if (outcome.effect === 'quit') {
      quit();
    } else if (outcome.effect === 'clear') {
      lastMessages = null;
    } else if (outcome.effect === 'cancel-run') {
      if (currentAbort) {
        currentAbort.abort();
      }
    } else if (outcome.effect === 'compact') {
      startRun('/compact');
    } else if (outcome.effect === 'start-run') {
      // /retry re-runs the prompt fresh (no continuation), like `kodr replay`.
      lastMessages = null;
      startRun(outcome.prompt);
    } else if (outcome.effect === 'diff') {
      showDiff();
    } else if (outcome.effect === 'doctor') {
      showDoctor();
    }
  }

  // Fire-and-forget from applyEffect, so both guard against a thrown error --
  // an unhandled rejection while idle would trip onFatal and tear the session
  // down. A failure just prints a notice instead.
  async function showDiff() {
    try {
      const result = await runShell('git diff', options.cwd || '.', {
        timeout: 10000,
      });
      const output = result.stdout.trim();
      if (result.exitCode !== 0 && !output) {
        pushLine(
          state,
          formatNotice(`git diff failed: ${result.stderr.trim()}`),
        );
      } else if (!output) {
        pushLine(state, formatNotice('no changes'));
      } else {
        for (const line of output.split('\n')) {
          pushLine(state, line);
        }
      }
    } catch (err) {
      pushLine(state, formatNotice(`git diff failed: ${err.message}`));
    }
    requestRender();
  }

  async function showDoctor() {
    try {
      const report = await runDoctorChecks({
        provider: options.provider,
        baseUrl: options.baseUrl,
        model: session.model,
      });
      for (const line of formatDoctorReport(report).split('\n')) {
        pushLine(state, line);
      }
    } catch (err) {
      pushLine(state, formatNotice(`doctor failed: ${err.message}`));
    }
    requestRender();
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
    if (key.name === 'tab') {
      completeInput();
    } else if (key.name === 'backspace') {
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

  // Tab completes a partially-typed slash command in place (see
  // src/tui-commands.mjs completeCommand); a no-op for anything else.
  function completeInput() {
    const completed = completeCommand(state.input);
    if (completed !== state.input) {
      setInput(state, completed);
    }
  }

  function cleanup() {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (ticker) {
      clearInterval(ticker);
    }
    if (quitTimer) {
      clearTimeout(quitTimer);
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
    submitLine(firstPrompt.trim());
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
