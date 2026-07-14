import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, describe, it } from 'node:test';

import {
  abortError,
  assembleResponse,
  createClient,
  hasContextHeadroom,
  isAbortError,
  isRetryableConnectionError,
  isRetryableServerError,
  isTimeoutError,
  pickContextInfo,
} from '../src/model.mjs';

const servers = [];
const originalKodrModel = process.env.KODR_MODEL;

after(() => {
  if (originalKodrModel === undefined) {
    delete process.env.KODR_MODEL;
  } else {
    process.env.KODR_MODEL = originalKodrModel;
  }
});

afterEach(async () => {
  if (originalKodrModel === undefined) {
    delete process.env.KODR_MODEL;
  } else {
    process.env.KODR_MODEL = originalKodrModel;
  }
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe('assembleResponse', () => {
  it('assembles content and token usage', () => {
    const result = assembleResponse([
      { choices: [{ delta: { role: 'assistant', content: 'hello' } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]);

    assert.equal(result.message.content, 'hello');
    assert.deepEqual(result.usage, { prompt: 12, completion: 3, cost: 0 });
  });

  it('accumulates tool call arguments and generates missing IDs', () => {
    const result = assembleResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'read_file', arguments: '{' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"path":"a"}' } },
              ],
            },
          },
        ],
      },
    ]);

    const call = result.message.tool_calls[0];
    assert.match(call.id, /^call_/);
    assert.equal(call.function.name, 'read_file');
    assert.equal(call.function.arguments, '{"path":"a"}');
  });

  it('densifies tool calls when a provider skips a stream index', () => {
    // Deltas arrive for index 0 and index 2, with no index 1 -- a sparse
    // array. The result must be dense so a for..of over tool_calls never
    // yields undefined (which would crash the loop on tc.function).
    const result = assembleResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'read_file', arguments: '{}' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 2,
                  function: { name: 'list_files', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
    ]);

    assert.equal(result.message.tool_calls.length, 2);
    assert.ok(result.message.tool_calls.every((tc) => tc && tc.function));
    assert.deepEqual(
      result.message.tool_calls.map((tc) => tc.function.name),
      ['read_file', 'list_files'],
    );
    // The sparse hole must not survive as an undefined entry.
    for (const tc of result.message.tool_calls) {
      assert.ok(tc.function.name);
    }
  });

  it('accumulates reasoning content and reasoning_details across chunks', () => {
    const result = assembleResponse([
      {
        choices: [
          {
            delta: {
              role: 'assistant',
              reasoning: 'Step one. ',
              reasoning_details: [
                { type: 'reasoning.text', text: 'Step one. ', index: 0 },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning: 'Step two.',
              reasoning_details: [
                { type: 'reasoning.text', text: 'Step two.', index: 0 },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { content: 'answer' } }] },
    ]);

    assert.equal(result.message.reasoning, 'Step one. Step two.');
    assert.equal(result.message.reasoning_details.length, 2);
    assert.equal(result.message.content, 'answer');
  });

  it('omits reasoning fields entirely when no reasoning deltas arrive', () => {
    const result = assembleResponse([
      { choices: [{ delta: { content: 'hello' } }] },
    ]);
    assert.equal(result.message.reasoning, undefined);
    assert.equal(result.message.reasoning_details, undefined);
  });

  it('captures usage from a chunk whose delta is present but near-empty (e.g. OpenRouter final chunk)', () => {
    const result = assembleResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      {
        choices: [{ delta: { content: '', role: 'assistant' } }],
        usage: { prompt_tokens: 25, completion_tokens: 174 },
      },
    ]);
    assert.deepEqual(result.usage, { prompt: 25, completion: 174, cost: 0 });
  });
});

describe('model HTTP client', () => {
  it('requests streaming usage and returns it', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"cost":0.000123}}\n\n' +
            'data: [DONE]\n\n',
        );
      });
    });
    const client = createClient({ baseUrl, model: 'test' });
    const result = await client.chat({ messages: [] });
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.deepEqual(result.usage, {
      prompt: 4,
      completion: 1,
      cost: 0.000123,
    });
  });

  it('uses KODR_MODEL when no model option is provided', async () => {
    process.env.KODR_MODEL = 'env/model';
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      });
    });
    const client = createClient({ baseUrl });
    await client.chat({ messages: [] });
    assert.equal(await client.resolveModel(), 'env/model');
    assert.equal(requestBody.model, 'env/model');
  });

  it('prefers explicit model option over KODR_MODEL', async () => {
    process.env.KODR_MODEL = 'env/model';
    const client = createClient({ model: 'cli/model' });
    assert.equal(await client.resolveModel(), 'cli/model');
  });

  it('emits text tokens to onToken as they stream', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"role":"assistant","content":"he"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
          'data: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const tokens = [];
    const result = await client.chat({
      messages: [],
      onToken: (t) => tokens.push(t),
    });
    assert.deepEqual(tokens, ['he', 'llo']);
    assert.equal(
      /** @type {{ content: string }} */ (result.message).content,
      'hello',
    );
  });

  it('surfaces HTTP errors from model listing', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });
    const client = createClient({ baseUrl });
    await assert.rejects(client.models(), /HTTP 503/);
  });

  it('surfaces HTTP errors from chat', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(400);
      res.end('bad request');
    });
    const client = createClient({ baseUrl, model: 'test' });
    await assert.rejects(client.chat({ messages: [] }), /HTTP 400/);
  });

  it('retries a chat request once after a 5xx, then succeeds', async () => {
    let calls = 0;
    const baseUrl = await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(500);
        res.end('internal error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const result = await client.chat({ messages: [] });
    assert.equal(calls, 2);
    assert.equal(
      /** @type {{ content: string }} */ (result.message).content,
      'ok',
    );
  });

  it('rejects a 200 response that is not an SSE stream', async () => {
    // A proxy/provider returns HTTP 200 with a plain-JSON (non-streaming) body.
    // It has no `data:` framing, so it assembles into an empty message that the
    // loop would report as a successful no-op -- it must surface as an error.
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"hi"}}]}');
    });
    const client = createClient({ baseUrl, model: 'test', maxRetries: 0 });
    await assert.rejects(client.chat({ messages: [] }), /Non-SSE response/);
  });

  it('resolves an SSE stream that only sends [DONE]', async () => {
    // A real (if empty) event stream: it has `data:` framing, so it is not
    // treated as a non-SSE body even though it produces no content.
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    const client = createClient({ baseUrl, model: 'test' });
    const result = await client.chat({ messages: [] });
    assert.equal(
      /** @type {{ content: string }} */ (result.message).content,
      '',
    );
  });

  it('does not retry a 4xx from chat', async () => {
    let calls = 0;
    const baseUrl = await startServer((_req, res) => {
      calls++;
      res.writeHead(400);
      res.end('bad request');
    });
    const client = createClient({ baseUrl, model: 'test' });
    await assert.rejects(client.chat({ messages: [] }), /HTTP 400/);
    assert.equal(calls, 1);
  });

  it('retries a chat request once after a connection reset, then succeeds', async () => {
    let calls = 0;
    const baseUrl = await startServer((req, res) => {
      calls++;
      if (calls === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const result = await client.chat({ messages: [] });
    assert.equal(calls, 2);
    assert.equal(
      /** @type {{ content: string }} */ (result.message).content,
      'ok',
    );
  });

  it('does not retry an ECONNREFUSED from chat', async () => {
    // Nothing listens on this port -- the connection is refused every time,
    // so a retry would be pointless (and would just slow down surfacing a
    // real "LM Studio isn't running" error).
    const client = createClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test',
    });
    await assert.rejects(client.chat({ messages: [] }), (err) => {
      assert.equal(
        /** @type {NodeJS.ErrnoException} */ (err).code,
        'ECONNREFUSED',
      );
      return true;
    });
  });

  it('gives up after maxRetries and throws the last 5xx error', async () => {
    let calls = 0;
    const baseUrl = await startServer((_req, res) => {
      calls++;
      res.writeHead(502);
      res.end('bad gateway');
    });
    const client = createClient({ baseUrl, model: 'test', maxRetries: 2 });
    await assert.rejects(client.chat({ messages: [] }), /HTTP 502/);
    assert.equal(calls, 3);
  });

  it('reports retries: 0 on a chat result when the first attempt succeeds', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const result = await client.chat({ messages: [] });
    assert.equal(result.retries, 0);
  });

  it('reports the number of retries used after a retried 5xx', async () => {
    let calls = 0;
    const baseUrl = await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(500);
        res.end('internal error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const result = await client.chat({ messages: [] });
    assert.equal(result.retries, 1);
  });

  it('attaches a retries count to the error thrown after exhausting maxRetries', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    const client = createClient({ baseUrl, model: 'test', maxRetries: 2 });
    await assert.rejects(client.chat({ messages: [] }), (err) => {
      assert.equal(/** @type {Error & { retries: number }} */ (err).retries, 2);
      return true;
    });
  });

  it('calls onDebug once with the request body and raw response text on success', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const debugCalls = [];
    await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onDebug: (record) => debugCalls.push(record),
    });

    assert.equal(debugCalls.length, 1);
    assert.equal(debugCalls[0].url, `${baseUrl}/chat/completions`);
    assert.equal(debugCalls[0].requestBody.messages[0].content, 'hi');
    assert.match(debugCalls[0].rawResponse, /"content":"ok"/);
    assert.equal(debugCalls[0].error, undefined);
  });

  it('calls onDebug once per attempt when a retry happens', async () => {
    let calls = 0;
    const baseUrl = await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(500);
        res.end('internal error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const debugCalls = [];
    await client.chat({
      messages: [],
      onDebug: (record) => debugCalls.push(record),
    });

    assert.equal(debugCalls.length, 2);
    assert.match(debugCalls[0].rawResponse, /internal error/);
    assert.match(debugCalls[1].rawResponse, /"content":"ok"/);
  });

  it('calls onDebug with an error and no response text on a connection failure', async () => {
    const client = createClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test',
    });
    const debugCalls = [];
    await assert.rejects(
      client.chat({
        messages: [],
        onDebug: (record) => debugCalls.push(record),
      }),
    );

    assert.equal(debugCalls.length, 1);
    assert.equal(debugCalls[0].rawResponse, '');
    assert.match(debugCalls[0].error, /ECONNREFUSED|connect/);
  });

  it('maxRetries: 0 disables retrying', async () => {
    let calls = 0;
    const baseUrl = await startServer((_req, res) => {
      calls++;
      res.writeHead(500);
      res.end('internal error');
    });
    const client = createClient({ baseUrl, model: 'test', maxRetries: 0 });
    await assert.rejects(client.chat({ messages: [] }), /HTTP 500/);
    assert.equal(calls, 1);
  });

  it('times out stalled requests', async () => {
    const baseUrl = await startServer(() => {});
    const client = createClient({ baseUrl, timeout: 20 });
    await assert.rejects(client.models(), /timed out/i);
  });

  it('times out long streaming requests even when chunks arrive', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"still"}}]}\n\n');
      const timer = setInterval(() => {
        res.write('data: {"choices":[{"delta":{"content":" going"}}]}\n\n');
      }, 5);
      res.on('close', () => clearInterval(timer));
    });
    const client = createClient({ baseUrl, model: 'test', timeout: 30 });
    await assert.rejects(client.chat({ messages: [] }), /timed out/i);
  });

  it('tags a chat timeout with a code isTimeoutError recognizes', async () => {
    const baseUrl = await startServer(() => {});
    const client = createClient({ baseUrl, model: 'test', timeout: 20 });
    await assert.rejects(client.chat({ messages: [] }), (err) => {
      const errnoErr = /** @type {NodeJS.ErrnoException} */ (err);
      assert.equal(errnoErr.code, 'ETIMEDOUT');
      assert.equal(isTimeoutError(errnoErr), true);
      return true;
    });
  });

  it('honors a per-call timeoutMs tighter than the client default', async () => {
    const baseUrl = await startServer(() => {});
    const client = createClient({ baseUrl, model: 'test', timeout: 60_000 });
    await assert.rejects(
      client.chat({ messages: [], timeoutMs: 20 }),
      /timed out after 20ms/i,
    );
  });

  it('falls back to the client default timeout when timeoutMs is omitted', async () => {
    const baseUrl = await startServer(() => {});
    const client = createClient({ baseUrl, model: 'test', timeout: 20 });
    await assert.rejects(
      client.chat({ messages: [] }),
      /timed out after 20ms/i,
    );
  });

  it('caps a per-call timeoutMs to the client ceiling — a larger value cannot exceed it', async () => {
    // The client timeout is a hard per-request ceiling: a per-call timeoutMs can
    // only shorten it, so 5000ms against a 20ms ceiling still fires at 20ms.
    const baseUrl = await startServer(() => {});
    const client = createClient({ baseUrl, model: 'test', timeout: 20 });
    await assert.rejects(
      client.chat({ messages: [], timeoutMs: 5000 }),
      /timed out after 20ms/i,
    );
  });

  it('calls onHeartbeat on an interval while a chat request is in flight', async () => {
    const baseUrl = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        );
      }, 120);
    });
    const client = createClient({ baseUrl, model: 'test' });
    const ticks = [];
    await client.chat({
      messages: [],
      heartbeatMs: 30,
      onHeartbeat: (elapsedMs) => ticks.push(elapsedMs),
    });
    assert.ok(
      ticks.length >= 2,
      `expected multiple ticks, got ${ticks.length}`,
    );
  });

  it('does not call onHeartbeat when heartbeatMs is 0', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const ticks = [];
    await client.chat({
      messages: [],
      heartbeatMs: 0,
      onHeartbeat: (elapsedMs) => ticks.push(elapsedMs),
    });
    assert.equal(ticks.length, 0);
  });

  it('stops calling onHeartbeat once the chat request finishes', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const client = createClient({ baseUrl, model: 'test' });
    const ticks = [];
    await client.chat({
      messages: [],
      heartbeatMs: 10,
      onHeartbeat: (elapsedMs) => ticks.push(elapsedMs),
    });
    const countAfterFinish = ticks.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ticks.length, countAfterFinish);
  });

  it('probes loaded and max context from /api/v0/models', async () => {
    let probedPath;
    const baseUrl = await startServer((req, res) => {
      probedPath = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'a/model',
              state: 'loaded',
              loaded_context_length: 8192,
              max_context_length: 131072,
            },
            {
              id: 'b/model',
              state: 'loaded',
              loaded_context_length: 32768,
              max_context_length: 262144,
            },
          ],
        }),
      );
    });
    const client = createClient({ baseUrl, model: 'b/model' });
    assert.deepEqual(await client.contextInfo('b/model'), {
      loaded: 32768,
      max: 262144,
    });
    assert.equal(probedPath, '/api/v0/models');
  });

  it('returns nulls when the probe endpoint is unavailable', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    const client = createClient({ baseUrl, model: 'test' });
    assert.deepEqual(await client.contextInfo('test'), {
      loaded: null,
      max: null,
    });
  });

  it('richModels returns an empty array when the endpoint is absent', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    const client = createClient({ baseUrl, model: 'test' });
    assert.deepEqual(await client.richModels(), []);
  });
});

describe('isTimeoutError', () => {
  it('is true for an error tagged with the ETIMEDOUT code', () => {
    assert.equal(
      isTimeoutError(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' })),
      true,
    );
  });

  it('is false for any other error (or none)', () => {
    assert.equal(isTimeoutError(new Error('HTTP 500: boom')), false);
    assert.equal(
      isTimeoutError(Object.assign(new Error('x'), { code: 'ECONNRESET' })),
      false,
    );
    assert.equal(isTimeoutError(undefined), false);
  });
});

describe('isRetryableServerError', () => {
  it('is true for a 5xx error', () => {
    assert.equal(isRetryableServerError(new Error('HTTP 500: boom')), true);
    assert.equal(isRetryableServerError(new Error('HTTP 503: boom')), true);
  });

  it('is false for a 4xx error', () => {
    assert.equal(isRetryableServerError(new Error('HTTP 400: boom')), false);
  });

  it('is false for a non-HTTP error', () => {
    assert.equal(
      isRetryableServerError(new Error('timed out after 20ms')),
      false,
    );
  });
});

describe('isRetryableConnectionError', () => {
  it('is true for ECONNRESET and EPIPE', () => {
    assert.equal(
      isRetryableConnectionError(
        Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        }),
      ),
      true,
    );
    assert.equal(
      isRetryableConnectionError(
        Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
      ),
      true,
    );
  });

  it('is false for ECONNREFUSED', () => {
    assert.equal(
      isRetryableConnectionError(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      ),
      false,
    );
  });

  it('is false for a non-connection error', () => {
    assert.equal(
      isRetryableConnectionError(new Error('HTTP 500: boom')),
      false,
    );
  });
});

describe('pickContextInfo', () => {
  it('prefers the entry matching the model id', () => {
    const models = [
      {
        id: 'a',
        state: 'loaded',
        loaded_context_length: 4096,
        max_context_length: 8192,
      },
      {
        id: 'b',
        state: 'loaded',
        loaded_context_length: 8192,
        max_context_length: 131072,
      },
    ];
    assert.deepEqual(pickContextInfo(models, 'b'), {
      loaded: 8192,
      max: 131072,
    });
  });

  it('falls back to any loaded model when the id is missing', () => {
    const models = [
      { id: 'a', state: 'not-loaded', max_context_length: 200000 },
      {
        id: 'b',
        state: 'loaded',
        loaded_context_length: 16384,
        max_context_length: 262144,
      },
    ];
    assert.deepEqual(pickContextInfo(models, 'missing'), {
      loaded: 16384,
      max: 262144,
    });
  });

  it('returns nulls when no loaded length is reported', () => {
    const models = [{ id: 'a', state: 'not-loaded', max_context_length: 1000 }];
    assert.deepEqual(pickContextInfo(models, 'a'), { loaded: null, max: null });
  });

  it('returns nulls for an empty listing', () => {
    assert.deepEqual(pickContextInfo([], 'a'), { loaded: null, max: null });
  });
});

describe('hasContextHeadroom', () => {
  it('flags a model loaded well below its max', () => {
    assert.equal(hasContextHeadroom(32768, 262144), true);
    assert.equal(hasContextHeadroom(8192, 131072), true);
  });

  it('does not flag a model loaded at (or near) its max', () => {
    assert.equal(hasContextHeadroom(32768, 32768), false);
    assert.equal(hasContextHeadroom(32768, 49152), false);
  });

  it('returns false when either length is unknown', () => {
    assert.equal(hasContextHeadroom(null, 262144), false);
    assert.equal(hasContextHeadroom(8192, null), false);
    assert.equal(hasContextHeadroom(0, 262144), false);
  });
});

describe('abort signal', () => {
  afterEach(async () => {
    while (servers.length) {
      await closeServer(servers.pop());
    }
  });

  it('tags an abort with a code isAbortError recognizes', () => {
    const err = abortError();
    assert.equal(/** @type {NodeJS.ErrnoException} */ (err).code, 'ABORT_ERR');
    assert.equal(isAbortError(err), true);
    assert.equal(isAbortError(new Error('other')), false);
    assert.equal(isAbortError(undefined), false);
  });

  it('aborts an in-flight chat request when the signal fires', async () => {
    // A server that starts streaming but never ends: the only way this chat
    // settles is the abort tearing the socket down.
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"work"}}]}\n\n');
    });
    const client = createClient({ baseUrl, model: 'test', timeout: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      client.chat({ messages: [], signal: controller.signal }),
      (err) => {
        assert.equal(
          isAbortError(/** @type {NodeJS.ErrnoException} */ (err)),
          true,
        );
        return true;
      },
    );
  });

  it('rejects immediately when the signal is already aborted', async () => {
    let handled = false;
    const baseUrl = await startServer((_req, res) => {
      handled = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    const client = createClient({ baseUrl, model: 'test', timeout: 60_000 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client.chat({ messages: [], signal: controller.signal }),
      (err) => isAbortError(/** @type {NodeJS.ErrnoException} */ (err)),
    );
    assert.equal(
      handled,
      false,
      'the destroyed request never reached the server',
    );
  });

  it('does not retry an aborted request', async () => {
    let requests = 0;
    const baseUrl = await startServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    });
    const client = createClient({
      baseUrl,
      model: 'test',
      maxRetries: 3,
      timeout: 60_000,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      client.chat({ messages: [], signal: controller.signal }),
      (err) => isAbortError(/** @type {NodeJS.ErrnoException} */ (err)),
    );
    assert.equal(requests, 1, 'an abort is terminal, not retried');
  });
});

async function startServer(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  return `http://127.0.0.1:${address.port}/v1`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
