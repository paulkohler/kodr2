/**
 * A reusable ACP *client* for driving a real `kodr acp` agent subprocess in
 * tests (see specs/acp.yaml). Zero dependencies — spawns the CLI, frames
 * newline-delimited JSON-RPC 2.0 over its stdio, answers the server->client
 * requests kodr issues (fs/*, terminal/*, session/request_permission), and
 * captures session/update notifications.
 *
 * This is the client half of the protocol — the half an editor like Zed
 * implements. It is deliberately dependency-free and importable (not a
 * standalone script) so both the fast, model-free transport test
 * (test/acp-stdio.test.mjs) and the live eval (eval/acp.eval.mjs) share one
 * client. `eval/*.eval.mjs` is a shallow glob, so this file under eval/support/
 * is never auto-run as a test.
 */

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../bin/kodr.mjs', import.meta.url));

/**
 * Spawn `kodr acp` and return a client for driving it.
 * @param {object} [options]
 * @param {string[]} [options.cliArgs] - Extra args after `acp` (e.g. provider/model/--no-save)
 * @param {string} [options.cwd] - Working dir for the kodr process (defaults to the repo root)
 * @param {boolean} [options.installDefaults] - Wire default fs/terminal/permission
 *   handlers backing onto real disk / real command execution (default true)
 * @param {'allow'|'reject'} [options.permission] - Default permission decision (default 'allow')
 * @returns {AcpTestClient}
 */
export function createAcpTestClient(options = {}) {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const child = spawn(
    process.execPath,
    [CLI, 'acp', ...(options.cliArgs ?? [])],
    {
      cwd: options.cwd ?? repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const state = {
    nextId: 1,
    pending: new Map(),
    handlers: new Map(),
    requestsByMethod: new Map(),
    updates: [],
    received: [],
    listeners: new Set(),
    stderr: '',
    exit: null,
  };

  child.stderr.on('data', (d) => {
    state.stderr += d.toString();
  });
  child.on('exit', (code, signal) => {
    state.exit = { code, signal };
  });

  function send(obj) {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function request(method, params) {
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  const rl = createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    route(message);
  });

  async function route(message) {
    state.received.push(message);
    for (const listener of state.listeners) {
      listener(message);
    }

    const hasId = message.id !== undefined && message.id !== null;
    if (
      hasId &&
      ('result' in message || 'error' in message) &&
      state.pending.has(message.id)
    ) {
      settleResponse(message);
      return;
    }
    if (typeof message.method === 'string' && hasId) {
      await dispatchServerRequest(message);
      return;
    }
    if (message.method === 'session/update') {
      state.updates.push(message.params?.update ?? {});
    }
  }

  function settleResponse(message) {
    const waiter = state.pending.get(message.id);
    state.pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        Object.assign(new Error(message.error.message || 'rpc error'), {
          code: message.error.code,
        }),
      );
      return;
    }
    waiter.resolve(message.result);
  }

  async function dispatchServerRequest(message) {
    const { id, method, params = {} } = message;
    const list = state.requestsByMethod.get(method) ?? [];
    list.push(params);
    state.requestsByMethod.set(method, list);

    const handler = state.handlers.get(method);
    if (!handler) {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    try {
      const result = await handler(params);
      send({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err.message },
      });
    }
  }

  /** @type {AcpTestClient} */
  const client = {
    child,
    request,
    notify,
    sendRaw: (line) => child.stdin.write(`${line}\n`),
    setRequestHandler: (method, fn) => state.handlers.set(method, fn),
    updates: state.updates,
    received: state.received,
    callsFor: (method) => state.requestsByMethod.get(method) ?? [],
    stderr: () => state.stderr,
    exitInfo: () => state.exit,

    waitForUpdate(predicate, timeoutMs = 10_000) {
      return waitFor(
        state.updates,
        state.listeners,
        () => state.updates.find(predicate),
        timeoutMs,
        'update',
      );
    },

    waitForMessage(predicate, timeoutMs = 10_000) {
      return waitFor(
        state.received,
        state.listeners,
        () => state.received.find(predicate),
        timeoutMs,
        'message',
      );
    },

    close() {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      rl.close();
    },
  };

  if (options.installDefaults !== false) {
    installDefaultHandlers(client, {
      permission: options.permission ?? 'allow',
    });
  }

  return client;
}

/**
 * Register the default server->client handlers an editor would provide: fs
 * reads/writes backed by real disk, terminal execution via a real child
 * process, and an auto-decision on permission requests. Tests can override any
 * of these afterward with setRequestHandler.
 * @param {AcpTestClient} client
 * @param {{ permission: 'allow'|'reject' }} opts
 */
export function installDefaultHandlers(client, opts) {
  const terminals = new Map();
  let terminalCount = 0;

  client.setRequestHandler('fs/read_text_file', async (params) => {
    return { content: await readFile(params.path, 'utf8') };
  });

  client.setRequestHandler('fs/write_text_file', async (params) => {
    await writeFile(params.path, params.content ?? '', 'utf8');
    return {};
  });

  client.setRequestHandler('terminal/create', async (params) => {
    terminalCount++;
    const terminalId = `client_term_${terminalCount}`;
    let output = '';
    let exitCode = 0;
    try {
      const { stdout, stderr } = await execFileAsync(
        params.command,
        params.args ?? [],
        { cwd: params.cwd, timeout: 30_000 },
      );
      output = `${stdout}${stderr}`;
    } catch (err) {
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      exitCode = typeof err.code === 'number' ? err.code : 1;
    }
    terminals.set(terminalId, { output, exitCode });
    return { terminalId };
  });

  client.setRequestHandler('terminal/wait_for_exit', (params) => {
    const term = terminals.get(params.terminalId);
    return { exitStatus: { exitCode: term ? term.exitCode : 0 } };
  });

  client.setRequestHandler('terminal/output', (params) => {
    const term = terminals.get(params.terminalId);
    return { output: term ? term.output : '' };
  });

  client.setRequestHandler('terminal/release', () => null);
  client.setRequestHandler('terminal/kill', () => null);

  client.setRequestHandler('session/request_permission', () => {
    const optionId = opts.permission === 'reject' ? 'reject' : 'allow';
    return { outcome: { outcome: 'selected', optionId } };
  });
}

/**
 * Resolve when `find()` returns a truthy match, either now or on a future
 * item. Rejects on timeout. Shared by waitForUpdate / waitForMessage.
 */
function waitFor(_items, listeners, find, timeoutMs, label) {
  const existing = find();
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = () => {
      const match = find();
      if (match) {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(match);
      }
    };
    listeners.add(listener);
  });
}

/**
 * @typedef {object} AcpTestClient
 * @property {import('node:child_process').ChildProcess} child
 * @property {(method: string, params?: object) => Promise<any>} request
 * @property {(method: string, params?: object) => void} notify
 * @property {(line: string) => void} sendRaw - Write a raw line to stdin (for malformed-input tests)
 * @property {(method: string, fn: (params: any) => any) => void} setRequestHandler
 * @property {Array<object>} updates - Captured session/update payloads, in order
 * @property {Array<object>} received - Every parsed message from the agent, in order
 * @property {(method: string) => Array<object>} callsFor - Params of every server->client request of a method
 * @property {() => string} stderr - Accumulated agent stderr
 * @property {() => ({ code: number, signal: string }|null)} exitInfo
 * @property {(predicate: (u: any) => boolean, timeoutMs?: number) => Promise<any>} waitForUpdate
 * @property {(predicate: (m: any) => boolean, timeoutMs?: number) => Promise<any>} waitForMessage
 * @property {() => void} close
 */
