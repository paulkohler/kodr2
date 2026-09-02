import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, describe, it } from 'node:test';

import {
  createProvider,
  reasoningEnabled,
  resolveProviderName,
} from '../src/provider.mjs';
import { createLMStudioProvider } from '../src/provider-lmstudio.mjs';
import { createOllamaProvider } from '../src/provider-ollama.mjs';
import {
  createOpenRouterProvider,
  dataCollectionDenied,
  isAnthropicModelId,
  openRouterCacheEnabled,
  resolveProviderOrder,
  zdrEnabled,
} from '../src/provider-openrouter.mjs';

const servers = [];
const ENV_VARS = [
  'KODR_MODEL',
  'KODR_PROVIDER',
  'KODR_REASONING',
  'OPENROUTER_API_KEY',
  'KODR_OPENROUTER_NO_ZDR',
  'KODR_OPENROUTER_ALLOW_DATA_COLLECTION',
  'KODR_OPENROUTER_PROVIDER_ONLY',
  'KODR_CACHE',
  'OLLAMA_API_KEY',
];
const originalEnv = Object.fromEntries(
  ENV_VARS.map((name) => [name, process.env[name]]),
);

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function restoreAllEnv() {
  for (const name of ENV_VARS) {
    restoreEnv(name, originalEnv[name]);
  }
}

after(() => {
  restoreAllEnv();
});

afterEach(async () => {
  restoreAllEnv();
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
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

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('resolveProviderName', () => {
  it('defaults to lmstudio', () => {
    delete process.env.KODR_PROVIDER;
    assert.equal(resolveProviderName(), 'lmstudio');
  });

  it('uses KODR_PROVIDER when no option is provided', () => {
    process.env.KODR_PROVIDER = 'openrouter';
    assert.equal(resolveProviderName(), 'openrouter');
  });

  it('prefers an explicit option over KODR_PROVIDER', () => {
    process.env.KODR_PROVIDER = 'openrouter';
    assert.equal(resolveProviderName('lmstudio'), 'lmstudio');
  });
});

describe('reasoningEnabled', () => {
  it('is off by default', () => {
    delete process.env.KODR_REASONING;
    assert.equal(reasoningEnabled(), false);
  });

  it('reads KODR_REASONING when no option is provided', () => {
    process.env.KODR_REASONING = '1';
    assert.equal(reasoningEnabled(), true);
  });

  it('an explicit false overrides KODR_REASONING', () => {
    process.env.KODR_REASONING = '1';
    assert.equal(reasoningEnabled(false), false);
  });

  it('an explicit true overrides an unset KODR_REASONING', () => {
    delete process.env.KODR_REASONING;
    assert.equal(reasoningEnabled(true), true);
  });
});

describe('zdrEnabled', () => {
  it('is on by default', () => {
    delete process.env.KODR_OPENROUTER_NO_ZDR;
    assert.equal(zdrEnabled(), true);
  });

  it('reads KODR_OPENROUTER_NO_ZDR when no option is provided', () => {
    process.env.KODR_OPENROUTER_NO_ZDR = '1';
    assert.equal(zdrEnabled(), false);
  });

  it('an explicit noZdr true disables it regardless of env', () => {
    delete process.env.KODR_OPENROUTER_NO_ZDR;
    assert.equal(zdrEnabled(true), false);
  });

  it('an explicit noZdr false overrides KODR_OPENROUTER_NO_ZDR', () => {
    process.env.KODR_OPENROUTER_NO_ZDR = '1';
    assert.equal(zdrEnabled(false), true);
  });
});

describe('dataCollectionDenied', () => {
  it('is denied (restricted) by default', () => {
    delete process.env.KODR_OPENROUTER_ALLOW_DATA_COLLECTION;
    assert.equal(dataCollectionDenied(), true);
  });

  it('reads KODR_OPENROUTER_ALLOW_DATA_COLLECTION when no option is provided', () => {
    process.env.KODR_OPENROUTER_ALLOW_DATA_COLLECTION = '1';
    assert.equal(dataCollectionDenied(), false);
  });

  it('an explicit allowDataCollection true disables the restriction regardless of env', () => {
    delete process.env.KODR_OPENROUTER_ALLOW_DATA_COLLECTION;
    assert.equal(dataCollectionDenied(true), false);
  });

  it('an explicit allowDataCollection false overrides the env var', () => {
    process.env.KODR_OPENROUTER_ALLOW_DATA_COLLECTION = '1';
    assert.equal(dataCollectionDenied(false), true);
  });
});

describe('resolveProviderOrder', () => {
  it('is empty by default', () => {
    delete process.env.KODR_OPENROUTER_PROVIDER_ONLY;
    assert.deepEqual(resolveProviderOrder(), []);
  });

  it('uses an explicit non-empty option', () => {
    assert.deepEqual(resolveProviderOrder(['akashml', 'parasail']), [
      'akashml',
      'parasail',
    ]);
  });

  it('falls back to KODR_OPENROUTER_PROVIDER_ONLY when no option is given', () => {
    process.env.KODR_OPENROUTER_PROVIDER_ONLY = 'akashml, parasail';
    assert.deepEqual(resolveProviderOrder(), ['akashml', 'parasail']);
  });

  it('an empty explicit option falls back to the env var rather than staying empty', () => {
    process.env.KODR_OPENROUTER_PROVIDER_ONLY = 'akashml';
    assert.deepEqual(resolveProviderOrder([]), ['akashml']);
  });
});

describe('isAnthropicModelId', () => {
  it('is true for an anthropic/* id', () => {
    assert.equal(isAnthropicModelId('anthropic/claude-opus-5'), true);
  });

  it('is true for an anthropic/* id with a :batch suffix', () => {
    assert.equal(isAnthropicModelId('anthropic/claude-fable-5.1:batch'), true);
  });

  it('is false for a non-anthropic id', () => {
    assert.equal(isAnthropicModelId('qwen/qwen3.6-35b-a3b'), false);
  });

  it('is false for an id that merely contains "anthropic" mid-string', () => {
    assert.equal(isAnthropicModelId('somevendor/anthropic-like-model'), false);
  });

  it('is false for an empty or undefined id', () => {
    assert.equal(isAnthropicModelId(''), false);
    assert.equal(isAnthropicModelId(undefined), false);
  });
});

describe('openRouterCacheEnabled', () => {
  it('is on by default for an anthropic/* model id', () => {
    delete process.env.KODR_CACHE;
    assert.equal(
      openRouterCacheEnabled(undefined, 'anthropic/claude-opus-5'),
      true,
    );
  });

  it('is off by default for a non-anthropic model id', () => {
    delete process.env.KODR_CACHE;
    assert.equal(
      openRouterCacheEnabled(undefined, 'qwen/qwen3.6-35b-a3b'),
      false,
    );
  });

  it('an explicit --cache (true) forces it on regardless of model id', () => {
    delete process.env.KODR_CACHE;
    assert.equal(openRouterCacheEnabled(true, 'qwen/qwen3.6-35b-a3b'), true);
  });

  it('an explicit --no-cache (false) forces it off even for an anthropic model', () => {
    delete process.env.KODR_CACHE;
    assert.equal(
      openRouterCacheEnabled(false, 'anthropic/claude-opus-5'),
      false,
    );
  });

  it('KODR_CACHE=1 forces it on when no explicit flag is given', () => {
    process.env.KODR_CACHE = '1';
    assert.equal(
      openRouterCacheEnabled(undefined, 'qwen/qwen3.6-35b-a3b'),
      true,
    );
  });

  it('KODR_CACHE=0 forces it off when no explicit flag is given', () => {
    process.env.KODR_CACHE = '0';
    assert.equal(
      openRouterCacheEnabled(undefined, 'anthropic/claude-opus-5'),
      false,
    );
  });

  it('an explicit flag overrides KODR_CACHE', () => {
    process.env.KODR_CACHE = '0';
    assert.equal(openRouterCacheEnabled(true, 'qwen/qwen3.6-35b-a3b'), true);
  });
});

describe('createProvider', () => {
  it('returns an lmstudio provider by default', () => {
    delete process.env.KODR_PROVIDER;
    const provider = createProvider({ model: 'test' });
    assert.deepEqual(provider.capabilities, {
      modelLifecycle: true,
      contextProbing: true,
      autoDetectModel: true,
      reasoning: false,
    });
  });

  it('returns an openrouter provider when requested', () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const provider = createProvider({ provider: 'openrouter', model: 'test' });
    assert.deepEqual(provider.capabilities, {
      modelLifecycle: false,
      contextProbing: false,
      autoDetectModel: false,
      reasoning: true,
    });
  });

  it('returns an ollama provider when requested', () => {
    const provider = createProvider({ provider: 'ollama', model: 'test' });
    assert.deepEqual(provider.capabilities, {
      modelLifecycle: false,
      contextProbing: false,
      autoDetectModel: true,
      reasoning: false,
    });
  });

  it('throws on an unknown provider name', () => {
    assert.throws(
      () => createProvider({ provider: 'bogus', model: 'test' }),
      /Unknown provider "bogus"/,
    );
  });

  it('throws when --reasoning is requested against a provider without reasoning support', () => {
    assert.throws(
      () =>
        createProvider({
          provider: 'lmstudio',
          model: 'test',
          reasoning: true,
        }),
      /--reasoning requires a provider with reasoning support.*"lmstudio"/,
    );
  });

  it('does not throw when --reasoning is requested against openrouter', () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    assert.doesNotThrow(() =>
      createProvider({
        provider: 'openrouter',
        model: 'test',
        reasoning: true,
      }),
    );
  });

  it('honors KODR_REASONING when reasoning is null (the CLI default, not false)', () => {
    // Reproduces the exact chain a CLI invocation with no --reasoning flag
    // goes through: parseArgs defaults args.reasoning to null (not false),
    // and that null reaches createProvider unchanged.
    process.env.OPENROUTER_API_KEY = 'sk-test';
    process.env.KODR_REASONING = '1';
    const provider = createProvider({
      provider: 'openrouter',
      model: 'test',
      reasoning: null,
    });
    assert.equal(provider.capabilities.reasoning, true);
  });

  it('an explicit reasoning: false (never sent by the CLI, but a valid library call) still overrides KODR_REASONING', () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    process.env.KODR_REASONING = '1';
    assert.doesNotThrow(() =>
      createProvider({
        provider: 'openrouter',
        model: 'test',
        reasoning: false,
      }),
    );
  });

  it('threads options.cache through to the openrouter factory', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createProvider({
      provider: 'openrouter',
      baseUrl,
      model: 'qwen/qwen3.6-35b-a3b',
      cache: true,
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.cache_control, { type: 'ephemeral' });
  });

  it('ignores options.cache for lmstudio and ollama', () => {
    assert.doesNotThrow(() =>
      createProvider({ provider: 'lmstudio', model: 'test', cache: true }),
    );
    assert.doesNotThrow(() =>
      createProvider({ provider: 'ollama', model: 'test', cache: true }),
    );
  });
});

describe('createLMStudioProvider', () => {
  it('defaults baseUrl to http://localhost:1234/v1', () => {
    const provider = createLMStudioProvider({ model: 'test' });
    assert.equal(provider.capabilities.modelLifecycle, true);
  });

  it('sends no Authorization header', async () => {
    let receivedHeaders;
    const baseUrl = await startServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    const provider = createLMStudioProvider({ baseUrl, model: 'test' });
    await provider.chat({ messages: [] });
    assert.equal(receivedHeaders.authorization, undefined);
  });

  it('never includes a reasoning field in the chat body', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createLMStudioProvider({ baseUrl, model: 'test' });
    await provider.chat({ messages: [] });
    assert.equal(requestBody.reasoning, undefined);
  });

  it('auto-detects the first loaded model when none is configured', async () => {
    delete process.env.KODR_MODEL;
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'loaded/model' }] }));
    });
    const provider = createLMStudioProvider({ baseUrl });
    assert.equal(await provider.resolveModel(), 'loaded/model');
  });

  it('exposes loadModel/ejectModel', () => {
    const provider = createLMStudioProvider({ model: 'test' });
    assert.equal(typeof provider.loadModel, 'function');
    assert.equal(typeof provider.ejectModel, 'function');
  });

  it('contextInfo returns real loaded/max values from richModels', async () => {
    const baseUrl = await startServer((req, res) => {
      if (req.url.startsWith('/api/v0/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'test',
                state: 'loaded',
                loaded_context_length: 8192,
                max_context_length: 32768,
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const provider = createLMStudioProvider({ baseUrl, model: 'test' });
    const info = await provider.contextInfo('test');
    assert.deepEqual(info, { loaded: 8192, max: 32768 });
  });
});

describe('createOpenRouterProvider', () => {
  it('throws at construction when OPENROUTER_API_KEY is unset', () => {
    delete process.env.OPENROUTER_API_KEY;
    assert.throws(
      () => createOpenRouterProvider({ model: 'test' }),
      /OPENROUTER_API_KEY is not set/,
    );
  });

  it('defaults baseUrl to https://openrouter.ai/api/v1', () => {
    const provider = createOpenRouterProvider({
      model: 'test',
      apiKey: 'sk-test',
    });
    assert.equal(provider.capabilities.reasoning, true);
  });

  it('sends an Authorization Bearer header from the API key', async () => {
    let receivedHeaders;
    const baseUrl = await startServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
    });
    await provider.chat({ messages: [] });
    assert.equal(receivedHeaders.authorization, 'Bearer sk-test');
  });

  it('includes { reasoning: { enabled: true } } in the chat body when requested', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
      reasoning: true,
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.reasoning, { enabled: true });
  });

  it('omits reasoning from the chat body when not requested', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
    });
    await provider.chat({ messages: [] });
    assert.equal(requestBody.reasoning, undefined);
  });

  it('resolveModel throws when no model is configured', async () => {
    delete process.env.KODR_MODEL;
    const provider = createOpenRouterProvider({ apiKey: 'sk-test' });
    await assert.rejects(provider.resolveModel(), /--model is required/);
  });

  it('resolveModel never calls models() to guess a default', async () => {
    delete process.env.KODR_MODEL;
    let called = false;
    const baseUrl = await startServer((_req, res) => {
      called = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'some/model' }] }));
    });
    const provider = createOpenRouterProvider({ baseUrl, apiKey: 'sk-test' });
    await assert.rejects(provider.resolveModel());
    assert.equal(called, false);
  });

  it('contextInfo returns the real context_length reported by /models', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'qwen/qwen3.6-35b-a3b', context_length: 262144 }],
        }),
      );
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'qwen/qwen3.6-35b-a3b',
      apiKey: 'sk-test',
    });
    assert.deepEqual(await provider.contextInfo('qwen/qwen3.6-35b-a3b'), {
      loaded: 262144,
      max: 262144,
    });
  });

  it('contextInfo returns nulls when the model is not in the /models listing', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'some/other-model', context_length: 8192 }],
        }),
      );
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'qwen/qwen3.6-35b-a3b',
      apiKey: 'sk-test',
    });
    assert.deepEqual(await provider.contextInfo('qwen/qwen3.6-35b-a3b'), {
      loaded: null,
      max: null,
    });
  });

  it('contextInfo returns nulls when the /models request fails', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'qwen/qwen3.6-35b-a3b',
      apiKey: 'sk-test',
    });
    assert.deepEqual(await provider.contextInfo('qwen/qwen3.6-35b-a3b'), {
      loaded: null,
      max: null,
    });
  });

  it('sends provider.zdr and provider.data_collection deny by default', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.provider, {
      zdr: true,
      data_collection: 'deny',
    });
  });

  it('omits provider.zdr when noZdr is set', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
      noZdr: true,
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.provider, { data_collection: 'deny' });
  });

  it('omits provider.data_collection when allowDataCollection is set', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
      allowDataCollection: true,
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.provider, { zdr: true });
  });

  it('omits the provider field entirely when noZdr and allowDataCollection are both set and no order is given', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
      noZdr: true,
      allowDataCollection: true,
    });
    await provider.chat({ messages: [] });
    assert.equal(requestBody.provider, undefined);
  });

  it('maps providerOrder to provider.order', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
      providerOrder: ['akashml', 'parasail'],
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.provider, {
      zdr: true,
      data_collection: 'deny',
      order: ['akashml', 'parasail'],
    });
  });

  it('sends a root-level cache_control by default for an anthropic model', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'anthropic/claude-opus-5',
      apiKey: 'sk-test',
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.cache_control, { type: 'ephemeral' });
  });

  it('omits cache_control by default for a non-anthropic model', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'qwen/qwen3.6-35b-a3b',
      apiKey: 'sk-test',
    });
    await provider.chat({ messages: [] });
    assert.equal(requestBody.cache_control, undefined);
  });

  it('omits cache_control when --no-cache is set, even for an anthropic model', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'anthropic/claude-opus-5',
      apiKey: 'sk-test',
      cache: false,
    });
    await provider.chat({ messages: [] });
    assert.equal(requestBody.cache_control, undefined);
  });

  it('sends cache_control when --cache is set, even for a non-anthropic model', async () => {
    let requestBody;
    const baseUrl = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    const provider = createOpenRouterProvider({
      baseUrl,
      model: 'qwen/qwen3.6-35b-a3b',
      apiKey: 'sk-test',
      cache: true,
    });
    await provider.chat({ messages: [] });
    assert.deepEqual(requestBody.cache_control, { type: 'ephemeral' });
  });

  it('has no loadModel/ejectModel methods', () => {
    const provider = createOpenRouterProvider({
      model: 'test',
      apiKey: 'sk-test',
    });
    assert.equal(provider.loadModel, undefined);
    assert.equal(provider.ejectModel, undefined);
  });
});

describe('createOllamaProvider', () => {
  it('defaults baseUrl to http://localhost:11434/v1', () => {
    const provider = createOllamaProvider({ model: 'test' });
    assert.deepEqual(provider.capabilities, {
      modelLifecycle: false,
      contextProbing: false,
      autoDetectModel: true,
      reasoning: false,
    });
  });

  it('does not throw at construction when OLLAMA_API_KEY is unset -- local usage needs no auth', () => {
    delete process.env.OLLAMA_API_KEY;
    assert.doesNotThrow(() => createOllamaProvider({ model: 'test' }));
  });

  it('sends no Authorization header when no API key is configured', async () => {
    delete process.env.OLLAMA_API_KEY;
    let receivedHeaders;
    const baseUrl = await startServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    const provider = createOllamaProvider({ baseUrl, model: 'test' });
    await provider.chat({ messages: [] });
    assert.equal(receivedHeaders.authorization, undefined);
  });

  it('sends an Authorization Bearer header when an API key is configured (e.g. ollama.com)', async () => {
    let receivedHeaders;
    const baseUrl = await startServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    const provider = createOllamaProvider({
      baseUrl,
      model: 'test',
      apiKey: 'sk-test',
    });
    await provider.chat({ messages: [] });
    assert.equal(receivedHeaders.authorization, 'Bearer sk-test');
  });

  it('auto-detects the first model from the listing when none is configured', async () => {
    delete process.env.KODR_MODEL;
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-coder:30b' }] }));
    });
    const provider = createOllamaProvider({ baseUrl });
    assert.equal(await provider.resolveModel(), 'qwen3-coder:30b');
  });

  it('contextInfo degrades to nulls (no rich context-length endpoint)', async () => {
    const provider = createOllamaProvider({ model: 'test' });
    assert.deepEqual(await provider.contextInfo('test'), {
      loaded: null,
      max: null,
    });
  });

  it('has no loadModel/ejectModel methods', () => {
    const provider = createOllamaProvider({ model: 'test' });
    assert.equal(provider.loadModel, undefined);
    assert.equal(provider.ejectModel, undefined);
  });
});
