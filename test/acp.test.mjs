import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAcpAgent } from '../src/acp.mjs';
import { createJsonRpcConnection } from '../src/acp-protocol.mjs';

/**
 * Wire an agent onto a real connection with a capturing send and an injected
 * fake runFn, so prompts can be driven without a model.
 */
function setup(runFn, options = { cwd: '/base' }, agentExtra = {}) {
  const sent = [];
  const connection = createJsonRpcConnection({
    send: (message) => sent.push(message),
  });
  const agent = createAcpAgent({ connection, options, runFn, ...agentExtra });
  return { connection, sent, agent };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function newSession(connection, sent, cwd = '/work') {
  await connection.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd, mcpServers: [] },
  });
  const response = sent.find((m) => m.id === 1);
  return response.result.sessionId;
}

describe('createAcpAgent', () => {
  it('answers initialize with the protocol version and capabilities', async () => {
    const { connection, sent } = setup(async () => ({}));
    await connection.receive({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = sent.find((m) => m.id === 1).result;
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentCapabilities.loadSession, false);
    assert.deepEqual(result.authMethods, []);
  });

  it('session/new returns a deterministic sessionId and records the cwd', async () => {
    const { connection, sent, agent } = setup(async () => ({}));
    const id = await newSession(connection, sent, '/proj');
    assert.equal(id, 'sess_1');
    assert.equal(agent.sessions.get('sess_1').cwd, '/proj');
  });

  it('session/prompt runs one run() with the session cwd and resolves with a StopReason', async () => {
    let seenPrompt = null;
    let seenCwd = null;
    const runFn = async (prompt, opts) => {
      seenPrompt = prompt;
      seenCwd = opts.cwd;
      opts.reporter.token('working');
      return { stoppedReason: 'complete', messages: [{ role: 'user' }] };
    };
    const { connection, sent } = setup(runFn);
    const sessionId = await newSession(connection, sent, '/proj');

    await connection.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [{ type: 'text', text: 'do it' }],
      },
    });

    assert.equal(seenPrompt, 'do it');
    assert.equal(seenCwd, '/proj');
    // A streamed token became a session/update notification.
    const update = sent.find((m) => m.method === 'session/update');
    assert.equal(update.params.update.sessionUpdate, 'agent_message_chunk');
    // The prompt resolved with a StopReason.
    const response = sent.find((m) => m.id === 2);
    assert.deepEqual(response.result, { stopReason: 'end_turn' });
  });

  it("threads the prior run's messages into the next prompt as priorMessages", async () => {
    const priorSeen = [];
    const runFn = async (_prompt, opts) => {
      priorSeen.push(opts.priorMessages);
      return { stoppedReason: 'complete', messages: [{ role: 'assistant' }] };
    };
    const { connection, sent } = setup(runFn);
    const sessionId = await newSession(connection, sent);

    const prompt = (id) =>
      connection.receive({
        jsonrpc: '2.0',
        id,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'x' }] },
      });

    await prompt(2);
    await prompt(3);

    assert.equal(priorSeen[0], null);
    assert.deepEqual(priorSeen[1], [{ role: 'assistant' }]);
  });

  it('a gated run_command sends session/request_permission and approves on the allow option', async () => {
    let approved = null;
    const runFn = async (_prompt, opts) => {
      // The harness would set approveCommands; assert the front-end forces it.
      assert.equal(opts.approveCommands, true);
      const decision = await opts.confirm({
        name: 'run_command',
        args: { command: 'ls' },
      });
      approved = decision.approved;
      return { stoppedReason: 'complete', messages: [] };
    };
    const { connection, sent } = setup(runFn);
    const sessionId = await newSession(connection, sent);

    const done = connection.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'run ls' }] },
    });
    await tick();

    const permReq = sent.find((m) => m.method === 'session/request_permission');
    assert.ok(permReq, 'a permission request was sent');
    assert.equal(permReq.params.options[0].optionId, 'allow');

    await connection.receive({
      jsonrpc: '2.0',
      id: permReq.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    await done;
    assert.equal(approved, true);
  });

  it('resolves confirm as not approved when the client fails the permission request', async () => {
    // A client that answers session/request_permission with a JSON-RPC error
    // (or drops the connection) must deny by default, not crash the whole run.
    let decision = null;
    const runFn = async (_prompt, opts) => {
      decision = await opts.confirm({
        name: 'run_command',
        args: { command: 'ls' },
      });
      return { stoppedReason: 'complete', messages: [] };
    };
    const { connection, sent } = setup(runFn);
    const sessionId = await newSession(connection, sent);

    const done = connection.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'run ls' }] },
    });
    await tick();
    const permReq = sent.find((m) => m.method === 'session/request_permission');
    await connection.receive({
      jsonrpc: '2.0',
      id: permReq.id,
      error: { code: -32000, message: 'client blew up' },
    });
    await done;

    assert.deepEqual(decision, { approved: false });
    // The prompt still resolved with a StopReason — the run wasn't crashed.
    const response = sent.find((m) => m.id === 2);
    assert.deepEqual(response.result, { stopReason: 'end_turn' });
  });

  it('a rejected permission resolves confirm as not approved', async () => {
    let approved = null;
    const runFn = async (_prompt, opts) => {
      const decision = await opts.confirm({
        name: 'run_command',
        args: { command: 'rm -rf /' },
      });
      approved = decision.approved;
      return { stoppedReason: 'complete', messages: [] };
    };
    const { connection, sent } = setup(runFn);
    const sessionId = await newSession(connection, sent);

    const done = connection.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'danger' }] },
    });
    await tick();
    const permReq = sent.find((m) => m.method === 'session/request_permission');
    await connection.receive({
      jsonrpc: '2.0',
      id: permReq.id,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });
    await done;
    assert.equal(approved, false);
  });

  it('session/cancel makes the prompt resolve with the cancelled StopReason', async () => {
    let releaseRun;
    const runGate = new Promise((resolve) => {
      releaseRun = resolve;
    });
    const runFn = async () => {
      await runGate;
      return { stoppedReason: 'complete', messages: [] };
    };
    const { connection, sent } = setup(runFn);
    const sessionId = await newSession(connection, sent);

    const done = connection.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'slow' }] },
    });
    await tick();

    await connection.receive({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId },
    });
    releaseRun();
    await done;

    const response = sent.find((m) => m.id === 2);
    assert.deepEqual(response.result, { stopReason: 'cancelled' });
  });

  it('session/cancel aborts the in-flight run via its AbortSignal', async () => {
    // The run resolves only once its signal fires, so the prompt can settle
    // only if session/cancel actually aborted the controller passed to run().
    let seenSignal = null;
    const runFn = async (_prompt, opts) => {
      seenSignal = opts.signal;
      await new Promise((resolve) => {
        opts.signal.addEventListener('abort', resolve, { once: true });
      });
      return { stoppedReason: 'cancelled', messages: [] };
    };
    const { connection, sent } = setup(runFn);
    const sessionId = await newSession(connection, sent);

    const done = connection.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'slow' }] },
    });
    await tick();
    assert.equal(seenSignal.aborted, false);

    await connection.receive({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId },
    });
    await done;

    assert.equal(seenSignal.aborted, true);
    const response = sent.find((m) => m.id === 2);
    assert.deepEqual(response.result, { stopReason: 'cancelled' });
  });

  it('clears the session controller after a prompt settles', async () => {
    const runFn = async () => ({ stoppedReason: 'complete', messages: [] });
    const { connection, sent, agent } = setup(runFn);
    const sessionId = await newSession(connection, sent);
    await connection.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'x' }] },
    });
    // A late cancel (after the prompt resolved) has no controller to abort and
    // must not throw.
    assert.equal(
      /** @type {any} */ (agent.sessions.get(sessionId)).controller,
      null,
    );
    await connection.receive({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId },
    });
  });

  it('passes a backend that delegates fs reads once the client advertises fs.readTextFile', async () => {
    let backendResult = null;
    const runFn = async (_prompt, opts) => {
      backendResult = await opts.backend.readTextFile('/work/x.txt');
      return { stoppedReason: 'complete', messages: [] };
    };
    const { connection, sent } = setup(runFn);
    await connection.receive({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: { clientCapabilities: { fs: { readTextFile: true } } },
    });
    await connection.receive({
      jsonrpc: '2.0',
      id: 11,
      method: 'session/new',
      params: { cwd: '/work' },
    });
    const sessionId = sent.find((m) => m.id === 11).result.sessionId;

    const done = connection.receive({
      jsonrpc: '2.0',
      id: 12,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    });
    await tick();

    const fsReq = sent.find((m) => m.method === 'fs/read_text_file');
    assert.ok(fsReq, 'the read was delegated to the client');
    assert.equal(fsReq.params.path, '/work/x.txt');
    await connection.receive({
      jsonrpc: '2.0',
      id: fsReq.id,
      result: { content: 'buffer contents' },
    });
    await done;
    assert.deepEqual(backendResult, { content: 'buffer contents' });
  });

  it('keeps fs reads local when the client advertises no fs capability', async () => {
    let backendResult = null;
    const runFn = async (_prompt, opts) => {
      // No fs capability was advertised, so this resolves against the local
      // backend (a missing path just yields an error) and issues no request.
      backendResult = await opts.backend.readTextFile('/definitely/missing');
      return { stoppedReason: 'complete', messages: [] };
    };
    const { connection, sent } = setup(runFn);
    // initialize with no clientCapabilities at all (distinct id from newSession's).
    await connection.receive({ jsonrpc: '2.0', id: 5, method: 'initialize' });
    const sessionId = await newSession(connection, sent);

    await connection.receive({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    });

    assert.ok(
      backendResult.error,
      'the local read reported an error, not a delegation',
    );
    assert.ok(
      !sent.some((m) => m.method === 'fs/read_text_file'),
      'nothing was delegated to the client',
    );
  });

  it('seeds the first session from a --continue seed and later sessions start fresh', async () => {
    const priorMessagesSeen = [];
    const priorFilesSeen = [];
    const runFn = async (_prompt, opts) => {
      priorMessagesSeen.push(opts.priorMessages);
      priorFilesSeen.push(opts.priorFilesChanged);
      return { stoppedReason: 'complete', messages: [{ role: 'assistant' }] };
    };
    const seed = {
      priorMessages: [{ role: 'user', content: 'earlier conversation' }],
      priorFilesChanged: ['a.txt'],
    };
    const { connection, sent } = setup(
      runFn,
      { cwd: '/base' },
      {
        continueSeed: seed,
      },
    );

    const prompt = async (newId, promptId) => {
      await connection.receive({
        jsonrpc: '2.0',
        id: newId,
        method: 'session/new',
        params: { cwd: '/work' },
      });
      const sessionId = sent.find((m) => m.id === newId).result.sessionId;
      await connection.receive({
        jsonrpc: '2.0',
        id: promptId,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      });
    };

    await prompt(1, 2);
    await prompt(3, 4);

    // First session resumed the seed; the second started fresh.
    assert.deepEqual(priorMessagesSeen[0], seed.priorMessages);
    assert.deepEqual(priorFilesSeen[0], seed.priorFilesChanged);
    assert.equal(priorMessagesSeen[1], null);
    assert.deepEqual(priorFilesSeen[1], []);
  });

  it('an unknown method gets a -32601 error response', async () => {
    const { connection, sent } = setup(async () => ({}));
    await connection.receive({ jsonrpc: '2.0', id: 9, method: 'bogus/thing' });
    assert.equal(sent.find((m) => m.id === 9).error.code, -32601);
  });
});
