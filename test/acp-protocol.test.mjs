import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  agentCapabilities,
  createJsonRpcConnection,
  extractPromptText,
  initializeResult,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR,
  PROTOCOL_VERSION,
  stopReasonFor,
  toolKindFor,
} from '../src/acp-protocol.mjs';

describe('stopReasonFor', () => {
  it('maps complete/budget-exceeded/tool-limit/error and a cancelled flag', () => {
    assert.equal(stopReasonFor('complete'), 'end_turn');
    assert.equal(stopReasonFor('budget-exceeded'), 'max_turn_requests');
    assert.equal(stopReasonFor('tool-limit'), 'max_turn_requests');
    assert.equal(stopReasonFor('error'), 'refusal');
    assert.equal(stopReasonFor('anything-else'), 'end_turn');
    // Cancellation wins over the run's own reason.
    assert.equal(stopReasonFor('complete', true), 'cancelled');
  });
});

describe('agentCapabilities', () => {
  it('reports loadSession false and no prompt capabilities', () => {
    const caps = agentCapabilities();
    assert.equal(caps.loadSession, false);
    assert.deepEqual(caps.promptCapabilities, {
      image: false,
      audio: false,
      embeddedContext: false,
    });
  });

  it('initializeResult carries the protocol version and empty auth methods', () => {
    const result = initializeResult();
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(result.authMethods, []);
    assert.equal(result.agentCapabilities.loadSession, false);
  });
});

describe('extractPromptText', () => {
  it('concatenates text blocks and ignores non-text blocks', () => {
    const text = extractPromptText([
      { type: 'text', text: 'add ' },
      { type: 'image', data: 'xxx' },
      { type: 'text', text: 'validation' },
    ]);
    assert.equal(text, 'add validation');
  });

  it('returns an empty string for a missing or non-array prompt', () => {
    assert.equal(extractPromptText(undefined), '');
    assert.equal(extractPromptText('nope'), '');
  });
});

describe('toolKindFor', () => {
  it('maps each tool name to its ACP kind and unknown names to other', () => {
    assert.equal(toolKindFor('read_file'), 'read');
    assert.equal(toolKindFor('list_files'), 'read');
    assert.equal(toolKindFor('search'), 'read');
    assert.equal(toolKindFor('view_image'), 'read');
    assert.equal(toolKindFor('write_file'), 'edit');
    assert.equal(toolKindFor('edit_file'), 'edit');
    assert.equal(toolKindFor('run_command'), 'execute');
    assert.equal(toolKindFor('load_skill'), 'other');
    assert.equal(toolKindFor('mystery'), 'other');
  });
});

describe('createJsonRpcConnection', () => {
  function setup() {
    const sent = [];
    const connection = createJsonRpcConnection({
      send: (message) => sent.push(message),
    });
    return { connection, sent };
  }

  it('notify writes a params notification with no id', () => {
    const { connection, sent } = setup();
    connection.notify('session/update', { sessionId: 's1' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'session/update');
    assert.deepEqual(sent[0].params, { sessionId: 's1' });
    assert.equal('id' in sent[0], false);
  });

  it('request writes an id and resolves on the matching response', async () => {
    const { connection, sent } = setup();
    const promise = connection.request('session/request_permission', { x: 1 });
    assert.equal(sent.length, 1);
    const { id } = sent[0];
    assert.equal(typeof id, 'number');
    await connection.receive({ jsonrpc: '2.0', id, result: { ok: true } });
    assert.deepEqual(await promise, { ok: true });
  });

  it('routes an incoming request to its handler and writes the result', async () => {
    const { connection, sent } = setup();
    connection.setHandler('initialize', () => ({ protocolVersion: 1 }));
    await connection.receive({ jsonrpc: '2.0', id: 7, method: 'initialize' });
    assert.deepEqual(sent[0], {
      jsonrpc: '2.0',
      id: 7,
      result: { protocolVersion: 1 },
    });
  });

  it('dispatches a notification without writing a response', async () => {
    const { connection, sent } = setup();
    let seen = null;
    connection.setHandler('session/cancel', (params) => {
      seen = params;
    });
    await connection.receive({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's1' },
    });
    assert.deepEqual(seen, { sessionId: 's1' });
    assert.equal(sent.length, 0);
  });

  it('returns a -32601 error for an unknown method', async () => {
    const { connection, sent } = setup();
    await connection.receive({ jsonrpc: '2.0', id: 3, method: 'nope' });
    assert.equal(sent[0].error.code, METHOD_NOT_FOUND);
  });

  it('returns a -32603 error when a handler throws', async () => {
    const { connection, sent } = setup();
    connection.setHandler('boom', () => {
      throw new Error('kaboom');
    });
    await connection.receive({ jsonrpc: '2.0', id: 4, method: 'boom' });
    assert.equal(sent[0].error.code, INTERNAL_ERROR);
    assert.equal(sent[0].error.message, 'kaboom');
  });

  it('swallows a throwing notification handler instead of rejecting', async () => {
    // A notification has no id, so there is nothing to answer with an error;
    // receive() must still resolve (not reject) so the caller's fire-and-forget
    // receive(message) can't become a fatal unhandled rejection.
    const { connection } = setup();
    connection.setHandler('note', () => {
      throw new Error('handler blew up');
    });
    await assert.doesNotReject(
      connection.receive({ jsonrpc: '2.0', method: 'note' }),
    );
  });
});
