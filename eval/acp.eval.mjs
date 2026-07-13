/**
 * Integration eval — the ACP front-end end-to-end against a live model
 * (specs/acp.yaml). Drives a real `kodr acp` subprocess as an ACP *client*
 * (eval/support/acp-client.mjs) and proves the three things unit tests can't
 * with fakes: a real model's tool calls actually delegate over the wire to the
 * client's fs/terminal, and session/cancel interrupts a live generation.
 *
 * Run with: node --test eval/acp.eval.mjs
 * Requires LM Studio at localhost:1234 with a tool-capable model. Defaults to
 * qwen/qwen3-coder-30b; override with KODR_TEST_MODEL.
 *
 * Slow and non-deterministic (a model may decline to call a tool) — track pass
 * rates, not binary pass/fail, like the other evals. The transport/protocol
 * layer itself is covered deterministically by test/acp-stdio.test.mjs and
 * test/acp*.test.mjs; this file is only about the live agentic path.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { createAcpTestClient } from './support/acp-client.mjs';

const LM_STUDIO_URL = 'http://localhost:1234/v1';
const MODEL = process.env.KODR_TEST_MODEL || 'qwen/qwen3-coder-30b';

async function lmStudioAvailable() {
  return new Promise((resolve) => {
    const req = request(`${LM_STUDIO_URL}/models`, { timeout: 3000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

describe('acp eval', {
  skip: !(await lmStudioAvailable()) && 'LM Studio not available',
}, () => {
  let ws;
  let client;

  before(async () => {
    ws = await mkdtemp(join(tmpdir(), 'kodr-acp-eval-'));
    await writeFile(
      join(ws, 'notes.txt'),
      'The quick brown fox jumps over the lazy dog. Distributed systems are hard because of partial failure.\n',
      'utf8',
    );
  });

  after(async () => {
    if (ws) {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // A fresh agent process per test keeps the captured calls/updates isolated;
  // LM Studio keeps the model loaded between them, so only the first prompt
  // pays the load cost.
  beforeEach(async () => {
    client = createAcpTestClient({
      cliArgs: [
        '--provider',
        'lmstudio',
        '--base-url',
        LM_STUDIO_URL,
        '--model',
        MODEL,
        '--no-save',
      ],
      installDefaults: true,
    });
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
  });

  afterEach(() => {
    if (client) {
      client.close();
    }
  });

  it('delegates fs reads and writes during a real prompt', {
    timeout: 180_000,
  }, async () => {
    const { sessionId } = await client.request('session/new', {
      cwd: ws,
      mcpServers: [],
    });
    const res = await client.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Create a file called summary.txt in the workspace containing exactly one sentence summarizing notes.txt. Then read summary.txt back and tell me its contents. Use your tools.',
        },
      ],
    });

    assert.equal(typeof res.stopReason, 'string', 'the prompt resolved');
    // The write went to the client's fs/write_text_file, not kodr's local
    // disk -- that's the delegation working.
    assert.ok(
      client.callsFor('fs/write_text_file').length >= 1,
      'the write was delegated to the client',
    );
    // And the delegated write actually landed a file on disk.
    const summary = await readFile(join(ws, 'summary.txt'), 'utf8');
    assert.ok(summary.trim().length > 0, 'summary.txt has content');
    // The read-back was delegated too.
    assert.ok(
      client.callsFor('fs/read_text_file').length >= 1,
      'the read was delegated to the client',
    );
  });

  it('delegates run_command to the client terminal, gated by permission', {
    timeout: 120_000,
  }, async () => {
    const { sessionId } = await client.request('session/new', { cwd: ws });
    const res = await client.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Run the shell command `echo acp-works` and tell me its output.',
        },
      ],
    });

    assert.equal(typeof res.stopReason, 'string', 'the prompt resolved');
    // run_command is gated: the client is asked to authorize it.
    assert.ok(
      client.callsFor('session/request_permission').length >= 1,
      'the command was gated through the client',
    );
    // Execution was delegated to the client's terminal, wrapped in /bin/sh -c.
    const creates = client.callsFor('terminal/create');
    assert.ok(creates.length >= 1, 'the command was delegated to the terminal');
    assert.equal(creates[0].command, '/bin/sh');
    assert.equal(creates[0].args?.[0], '-c');
    assert.ok(
      client.callsFor('terminal/output').length >= 1,
      'the terminal output was collected',
    );
  });

  it('cancels an in-flight prompt via session/cancel', {
    timeout: 60_000,
  }, async () => {
    const { sessionId } = await client.request('session/new', { cwd: ws });
    // Start a long generation without awaiting, so we can cancel it mid-flight.
    const promptPromise = client.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Write a detailed 2000-word essay about distributed systems, thinking step by step. Be thorough.',
        },
      ],
    });

    // Once tokens are streaming, the run is genuinely in-flight; cancel it.
    await client.waitForUpdate(
      (u) => u.sessionUpdate === 'agent_message_chunk',
      30_000,
    );
    client.notify('session/cancel', { sessionId });

    const res = await promptPromise;
    assert.equal(
      res.stopReason,
      'cancelled',
      'cancel interrupts the in-flight run rather than finishing it',
    );
  });
});
