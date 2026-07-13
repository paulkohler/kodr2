/**
 * Fast, model-free transport test for `kodr acp` over a real subprocess
 * (specs/acp.yaml). Everything up to session/prompt is deterministic and never
 * touches a model, so this runs in CI where no LM Studio is available — it
 * covers the real stdio framing, readline, the CLI wiring, and the JSON-RPC
 * error paths that the in-process unit tests (test/acp.test.mjs) can't reach.
 * The live agentic loop (model -> tool call -> delegation) lives in
 * eval/acp.eval.mjs instead.
 */

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAcpTestClient } from '../eval/support/acp-client.mjs';

const CLI = fileURLToPath(new URL('../bin/kodr.mjs', import.meta.url));

describe('kodr acp stdio transport', () => {
  const clients = [];
  function newClient(options = {}) {
    const client = createAcpTestClient({ installDefaults: false, ...options });
    clients.push(client);
    return client;
  }

  after(() => {
    for (const client of clients) {
      client.close();
    }
  });

  it('negotiates initialize and issues deterministic session ids over real stdio', async () => {
    const client = newClient();
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentCapabilities.loadSession, false);
    assert.deepEqual(init.authMethods, []);

    // The per-process counter is deterministic: first session is sess_1.
    const first = await client.request('session/new', {
      cwd: '/tmp',
      mcpServers: [],
    });
    const second = await client.request('session/new', {
      cwd: '/tmp',
      mcpServers: [],
    });
    assert.equal(first.sessionId, 'sess_1');
    assert.equal(second.sessionId, 'sess_2');
  });

  it('answers an unknown method with -32601 and a malformed line with -32700', async () => {
    const client = newClient();

    await assert.rejects(client.request('bogus/method'), (err) => {
      assert.equal(/** @type {any} */ (err).code, -32601);
      return true;
    });

    // A non-JSON line is a parse error: the agent replies with id null so the
    // client can't correlate it to any request -- assert it via the raw stream.
    client.sendRaw('{ this is not valid json');
    const parseError = await client.waitForMessage(
      (m) => m.error && m.error.code === -32700,
      5000,
    );
    assert.equal(parseError.id, null);
  });

  it('ignores a cancel for an unknown session without crashing', async () => {
    const client = newClient();
    await client.request('initialize', { protocolVersion: 1 });

    // A cancel for a session that was never created is a no-op notification.
    client.notify('session/cancel', { sessionId: 'never-existed' });

    // The process must still be alive and answering — prove it with a request
    // that resolves after the stray cancel.
    const session = await client.request('session/new', { cwd: '/tmp' });
    assert.match(session.sessionId, /^sess_\d+$/);
    assert.equal(client.exitInfo(), null, 'the agent process is still running');
  });

  it('starts serving with a --continue seed resolved from a prior run', async () => {
    // A saved transcript in the workspace's runs dir; `--continue last` must
    // resolve it and the agent must still come up and serve (proving the
    // resolution didn't error out). That the seed reaches the first session is
    // covered in test/acp.test.mjs (no model needed there).
    const ws = await mkdtemp(join(tmpdir(), 'kodr-acp-cont-'));
    try {
      await mkdir(join(ws, '.kodr', 'runs'), { recursive: true });
      await writeFile(
        join(ws, '.kodr', 'runs', '2025-01-01T00-00-00.json'),
        JSON.stringify({
          messages: [
            { role: 'user', content: 'earlier' },
            { role: 'assistant', content: 'ok' },
          ],
          filesChanged: [],
        }),
        'utf8',
      );
      const client = newClient({
        cliArgs: ['--continue', 'last', '--cwd', ws],
      });
      const init = await client.request('initialize', { protocolVersion: 1 });
      assert.equal(init.protocolVersion, 1);
      const session = await client.request('session/new', { cwd: ws });
      assert.equal(session.sessionId, 'sess_1');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('exits non-zero when --continue cannot resolve a prior run', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'kodr-acp-cont-'));
    try {
      const { code, stderr } = await runToExit([
        'acp',
        '--continue',
        'does-not-exist',
        '--cwd',
        empty,
      ]);
      assert.equal(code, 1);
      assert.match(stderr, /No prior run found/i);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

/**
 * Run `kodr <args>` to completion (for paths that exit rather than serve) and
 * resolve with its exit code and stderr.
 */
function runToExit(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}
