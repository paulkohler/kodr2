/**
 * In-process driver test for the TUI (see specs/tui.yaml). Instead of spawning
 * `kodr tui` in a real PTY (which would need an external tool CI doesn't have),
 * runTui takes injected stdin/stdout streams: we write keystrokes into a fake
 * stdin and read the rendered frames out of a fake stdout. This exercises the
 * real input loop -- keypress decoding, command dispatch, and the render
 * pipeline -- deterministically and with no network. It only drives commands
 * that never call run() (/help, autocomplete, /quit, Ctrl-C), so no model.
 */

import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';

import { runTui } from '../src/tui.mjs';

/**
 * A fake stdin/stdout pair: write keystrokes to `stdin`, read rendered text via
 * text(). A non-TTY stream still decodes keypresses; runTui just skips the
 * raw-mode call, and draw() falls back to its default 24x80 dimensions -- both
 * deterministic.
 */
function makeIo() {
  const stdin = new PassThrough();
  const chunks = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { stdin, stdout, text: () => stripAnsi(chunks.join('')) };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping CSI (color + cursor) escapes needs the ESC control char
const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Drop ANSI control sequences so assertions see plain rendered text. */
function stripAnsi(str) {
  return str.replace(CSI, '');
}

/**
 * Resolve once `predicate()` holds (frames render on a ~16ms debounce).
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for TUI output'));
      }
    }, 5);
  });
}

const baseOptions = { provider: 'lmstudio', model: 'test-model', cwd: '.' };

describe('tui driver (in-process)', () => {
  it('lists the commands when you type /help, then quits cleanly', async () => {
    const io = makeIo();
    const done = runTui('', {
      ...baseOptions,
      stdin: io.stdin,
      stdout: io.stdout,
    });

    io.stdin.write('/help\r');
    await waitFor(
      () => io.text().includes('/compact') && io.text().includes('/quit'),
    );

    const out = io.text();
    assert.match(out, /›\s*\/help/, 'echoes the command line');
    assert.match(out, /\/doctor/, 'lists a representative command');

    io.stdin.write('/quit\r');
    await done; // resolves only on the clean teardown path
  });

  it('shows autocomplete for a partial command and needs two Ctrl-C to quit', async () => {
    const io = makeIo();
    const done = runTui('', {
      ...baseOptions,
      stdin: io.stdin,
      stdout: io.stdout,
      quitConfirmMs: 5000,
    });

    // A partial slash command turns the hint row into a live suggestion list.
    io.stdin.write('/c');
    await waitFor(
      () => io.text().includes('/compact') && io.text().includes('/clear'),
    );

    // First Ctrl-C must NOT quit -- it arms the confirmation. If it had quit,
    // this text would never render (armQuit is only reached when not quitting).
    io.stdin.write('\x03');
    await waitFor(() => io.text().includes('ctrl-c again to quit'));

    // Second Ctrl-C within the window quits.
    io.stdin.write('\x03');
    await done;
  });
});
