/**
 * The ACP filesystem/terminal backend (see specs/acp.yaml) — a ToolBackend
 * (src/tools/backend.mjs) that delegates the file and command tools' I/O to the
 * editor over JSON-RPC, so reads see unsaved buffers, writes land as the
 * editor's own edits, and commands run in the editor's terminal panel.
 *
 * Delegation is per-capability and gated on what the client advertised at
 * initialize: each operation the client did NOT claim falls back to the local
 * backend. The path jail still runs in the tools regardless (model output is
 * untrusted whether the write goes local or to the client) — this module only
 * receives already-jailed absolute paths.
 */

import { localBackend } from './tools/backend.mjs';

/**
 * Build an ACP-delegating backend for one session.
 * @param {object} params
 * @param {{ request: (method: string, params?: object) => Promise<any> }} params.connection
 * @param {string} params.sessionId - The ACP session id, sent on every request
 * @param {{ fs?: { readTextFile?: boolean, writeTextFile?: boolean }, terminal?: boolean }} [params.capabilities] -
 *   The client's advertised clientCapabilities; missing pieces degrade to local
 * @param {import('./tools/backend.mjs').ToolBackend} [params.local] - Local fallback
 * @returns {import('./tools/backend.mjs').ToolBackend}
 */
export function createAcpBackend(params) {
  const { connection, sessionId } = params;
  const capabilities = params.capabilities ?? {};
  const local = params.local ?? localBackend;
  const fs = capabilities.fs ?? {};

  return {
    readTextFile: fs.readTextFile
      ? (absPath) => clientRead(connection, sessionId, absPath)
      : local.readTextFile,
    writeTextFile: fs.writeTextFile
      ? (absPath, content) =>
          clientWrite(connection, sessionId, absPath, content)
      : local.writeTextFile,
    runCommand: capabilities.terminal
      ? (command, opts) => clientExec(connection, sessionId, command, opts)
      : local.runCommand,
  };
}

/**
 * Read a file through the client's fs/read_text_file. A transport failure
 * becomes an { error } result, matching the local backend's contract, so the
 * tool surfaces it to the model rather than throwing.
 */
async function clientRead(connection, sessionId, absPath) {
  try {
    const result = await connection.request('fs/read_text_file', {
      sessionId,
      path: absPath,
    });
    return { content: result?.content ?? '' };
  } catch (e) {
    return { error: e.message };
  }
}

/** Write a file through the client's fs/write_text_file. */
async function clientWrite(connection, sessionId, absPath, content) {
  try {
    await connection.request('fs/write_text_file', {
      sessionId,
      path: absPath,
      content,
    });
    return {};
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Run a command in the client's terminal (terminal/create → wait_for_exit →
 * output → release), shaped back into the { stdout, stderr, exitCode } the
 * run_command tool expects. The command is wrapped in `/bin/sh -c` so shell
 * semantics (pipes, &&, cd) match the local backend's runShell. ACP terminals
 * report a single combined output stream, so it is returned as stdout with an
 * empty stderr. A timeout kills the terminal and reports a non-zero exit,
 * mirroring runShell's own timeout behavior.
 * @param {{ cwd: string, env?: Record<string,string>, timeout?: number }} opts
 */
async function clientExec(connection, sessionId, command, opts) {
  let created;
  try {
    created = await connection.request('terminal/create', {
      sessionId,
      command: '/bin/sh',
      args: ['-c', command],
      cwd: opts.cwd,
      env: envToArray(opts.env),
    });
  } catch (e) {
    return { stdout: '', stderr: e.message, exitCode: 1 };
  }
  const terminalId = created?.terminalId;
  if (!terminalId) {
    return {
      stdout: '',
      stderr: 'terminal/create returned no terminalId',
      exitCode: 1,
    };
  }

  try {
    const waited = await waitForExit(
      connection,
      sessionId,
      terminalId,
      opts.timeout,
    );
    const out = await connection
      .request('terminal/output', { sessionId, terminalId })
      .catch(() => ({}));
    const exitCode = waited.timedOut ? 1 : (waited.exitStatus?.exitCode ?? 0);
    return { stdout: out.output ?? '', stderr: '', exitCode };
  } catch (e) {
    // runCommand must never throw (the ToolBackend contract, matching
    // shell.mjs): a client that fails to answer wait_for_exit mid-command
    // becomes a failed command result, not an uncaught rejection that unwinds
    // the whole run.
    return { stdout: '', stderr: e.message, exitCode: 1 };
  } finally {
    await connection
      .request('terminal/release', { sessionId, terminalId })
      .catch(() => {});
  }
}

/**
 * Wait for the client's terminal to exit, racing a timeout that kills it. A
 * timeout of 0 or undefined waits indefinitely (the client owns the process).
 * @returns {Promise<{ timedOut: boolean, exitStatus?: { exitCode?: number } }>}
 */
function waitForExit(connection, sessionId, terminalId, timeout) {
  const wait = connection
    .request('terminal/wait_for_exit', { sessionId, terminalId })
    .then((r) => ({ timedOut: false, exitStatus: r?.exitStatus }));
  if (!timeout || timeout <= 0) {
    return wait;
  }
  let timer;
  const timeoutP = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeout);
  });
  return Promise.race([wait, timeoutP]).then(async (result) => {
    clearTimeout(timer);
    if (result !== 'timeout') {
      return result;
    }
    await connection
      .request('terminal/kill', { sessionId, terminalId })
      .catch(() => {});
    return { timedOut: true };
  });
}

/**
 * Convert a Record<string,string> env into ACP's array-of-{name,value} form.
 * @param {Record<string,string>} [env]
 * @returns {Array<{ name: string, value: string }>}
 */
function envToArray(env) {
  if (!env) {
    return [];
  }
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}
