import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  assembleResponse,
  createClient,
  hasContextHeadroom,
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
    assert.deepEqual(result.usage, { prompt: 12, completion: 3 });
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
            'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n' +
            'data: [DONE]\n\n',
        );
      });
    });
    const client = createClient({ baseUrl, model: 'test' });
    const result = await client.chat({ messages: [] });
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.deepEqual(result.usage, { prompt: 4, completion: 1 });
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
    assert.equal(result.message.content, 'hello');
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

  it('times out stalled requests', async () => {
    const baseUrl = await startServer(() => {});
    const client = createClient({ baseUrl, timeout: 20 });
    await assert.rejects(client.models(), /timed out/i);
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

async function startServer(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/v1`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
