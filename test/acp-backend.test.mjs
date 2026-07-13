import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAcpBackend } from '../src/acp-backend.mjs';

/**
 * A fake JSON-RPC connection: records every request and answers via a
 * responder(method, params) that may return a value or a promise.
 */
function fakeConnection(responder) {
  const requests = [];
  return {
    requests,
    request(method, params) {
      requests.push({ method, params });
      return Promise.resolve(responder(method, params));
    },
  };
}

/**
 * A local backend stub whose three ops report which one ran. Typed `any` so a
 * marker return (writeTextFile's { local: true }) doesn't have to satisfy the
 * ToolBackend result shape just to prove the fallback path was taken.
 * @returns {any}
 */
function localStub() {
  return {
    readTextFile: async () => ({ content: 'LOCAL_READ' }),
    writeTextFile: async () => ({ local: true }),
    runCommand: async () => ({ stdout: 'LOCAL_RUN', stderr: '', exitCode: 0 }),
  };
}

describe('createAcpBackend fs delegation', () => {
  it('delegates readTextFile to fs/read_text_file when the client advertises it', async () => {
    const connection = fakeConnection((method) =>
      method === 'fs/read_text_file' ? { content: 'from-editor' } : null,
    );
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_1',
      capabilities: { fs: { readTextFile: true } },
      local: localStub(),
    });

    const result = await backend.readTextFile('/work/a.txt');
    assert.equal(result.content, 'from-editor');
    assert.deepEqual(connection.requests[0], {
      method: 'fs/read_text_file',
      params: { sessionId: 'sess_1', path: '/work/a.txt' },
    });
  });

  it('falls back to the local backend for reads when fs.readTextFile is not advertised', async () => {
    const connection = fakeConnection(() => null);
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_1',
      capabilities: {},
      local: localStub(),
    });

    const result = await backend.readTextFile('/work/a.txt');
    assert.equal(result.content, 'LOCAL_READ');
    assert.equal(
      connection.requests.length,
      0,
      'no request went to the client',
    );
  });

  it('delegates writeTextFile to fs/write_text_file when advertised', async () => {
    const connection = fakeConnection(() => null);
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_2',
      capabilities: { fs: { writeTextFile: true } },
      local: localStub(),
    });

    const result = await backend.writeTextFile('/work/b.txt', 'hello');
    assert.deepEqual(result, {});
    assert.deepEqual(connection.requests[0], {
      method: 'fs/write_text_file',
      params: { sessionId: 'sess_2', path: '/work/b.txt', content: 'hello' },
    });
  });

  it('falls back to the local backend for writes when not advertised', async () => {
    const connection = fakeConnection(() => null);
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_2',
      capabilities: { fs: {} },
      local: localStub(),
    });

    const result = await backend.writeTextFile('/work/b.txt', 'hello');
    assert.deepEqual(result, { local: true });
    assert.equal(connection.requests.length, 0);
  });

  it('turns a client transport error into an { error } result', async () => {
    const connection = fakeConnection(() => {
      throw new Error('client refused');
    });
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_1',
      capabilities: { fs: { readTextFile: true } },
      local: localStub(),
    });

    const result = await backend.readTextFile('/work/a.txt');
    assert.equal(result.error, 'client refused');
  });
});

describe('createAcpBackend terminal delegation', () => {
  const terminalResponder = (method) => {
    if (method === 'terminal/create') {
      return { terminalId: 'term_1' };
    }
    if (method === 'terminal/wait_for_exit') {
      return { exitStatus: { exitCode: 3 } };
    }
    if (method === 'terminal/output') {
      return { output: 'combined output', truncated: false };
    }
    return null;
  };

  it('runs a command through terminal/* and shapes the result', async () => {
    const connection = fakeConnection(terminalResponder);
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_9',
      capabilities: { terminal: true },
      local: localStub(),
    });

    const result = await backend.runCommand('echo hi', {
      cwd: '/work',
      env: { PATH: '/bin' },
      timeout: 0,
    });

    assert.deepEqual(result, {
      stdout: 'combined output',
      stderr: '',
      exitCode: 3,
    });
    const create = connection.requests.find(
      (r) => r.method === 'terminal/create',
    );
    assert.equal(create.params.command, '/bin/sh');
    assert.deepEqual(create.params.args, ['-c', 'echo hi']);
    assert.equal(create.params.cwd, '/work');
    assert.deepEqual(create.params.env, [{ name: 'PATH', value: '/bin' }]);
    // The terminal is always released.
    assert.ok(connection.requests.some((r) => r.method === 'terminal/release'));
  });

  it('falls back to the local backend for commands when terminal is not advertised', async () => {
    const connection = fakeConnection(terminalResponder);
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_9',
      capabilities: {},
      local: localStub(),
    });

    const result = await backend.runCommand('echo hi', { cwd: '/work' });
    assert.equal(result.stdout, 'LOCAL_RUN');
    assert.equal(connection.requests.length, 0);
  });

  it('kills the terminal and reports a non-zero exit on timeout', async () => {
    const connection = fakeConnection((method) => {
      if (method === 'terminal/create') {
        return { terminalId: 'term_1' };
      }
      if (method === 'terminal/wait_for_exit') {
        return new Promise(() => {}); // never exits
      }
      if (method === 'terminal/output') {
        return { output: 'partial' };
      }
      return null;
    });
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_9',
      capabilities: { terminal: true },
      local: localStub(),
    });

    const result = await backend.runCommand('sleep 100', {
      cwd: '/work',
      timeout: 20,
    });

    assert.equal(result.exitCode, 1);
    assert.ok(
      connection.requests.some((r) => r.method === 'terminal/kill'),
      'a timed-out terminal is killed',
    );
  });

  it('reports a wait_for_exit rejection as a command error and still releases', async () => {
    // runCommand must never throw: a client that fails mid-command becomes a
    // failed command result, not an uncaught rejection that unwinds the run.
    const connection = fakeConnection((method) => {
      if (method === 'terminal/create') {
        return { terminalId: 'term_1' };
      }
      if (method === 'terminal/wait_for_exit') {
        return Promise.reject(new Error('client died'));
      }
      return null;
    });
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_9',
      capabilities: { terminal: true },
      local: localStub(),
    });

    const result = await backend.runCommand('echo hi', {
      cwd: '/work',
      timeout: 0,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /client died/);
    assert.ok(
      connection.requests.some((r) => r.method === 'terminal/release'),
      'the terminal is released even after a failure',
    );
  });

  it('reports terminal/create failure as a command error', async () => {
    const connection = fakeConnection((method) => {
      if (method === 'terminal/create') {
        throw new Error('no terminal capability');
      }
      return null;
    });
    const backend = createAcpBackend({
      connection,
      sessionId: 'sess_9',
      capabilities: { terminal: true },
      local: localStub(),
    });

    const result = await backend.runCommand('echo hi', { cwd: '/work' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no terminal capability/);
  });
});
