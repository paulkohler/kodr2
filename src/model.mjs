/**
 * LM Studio client.
 * Handles chat completions with tool support and streaming.
 * Single provider, single API shape: OpenAI-compatible.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_TIMEOUT = 600_000; // 10 minutes
export const DEFAULT_MAX_RETRIES = 1;

/**
 * Create a model client bound to an OpenAI-compatible chat completions
 * endpoint. Used directly for LM Studio; wrapped by provider-*.mjs modules
 * to add per-provider auth headers, extra body fields (e.g. reasoning), and
 * capability differences (see specs/provider.yaml).
 * @param {object} [options]
 * @param {string} [options.baseUrl] - API base URL
 * @param {string} [options.model] - Model identifier
 * @param {number} [options.timeout] - Request timeout in ms
 * @param {number} [options.maxRetries] - Retries for a 5xx chat response
 *   (transient local-backend crashes), default 1. 4xx and timeouts are
 *   never retried -- a 4xx would fail identically again, and a timeout
 *   already means the model took the full budget.
 * @param {object} [options.headers] - Extra HTTP headers sent with every
 *   request (e.g. an Authorization bearer token for a hosted provider)
 * @param {object} [options.extraBody] - Extra fields merged into every chat
 *   request body (e.g. { reasoning: { enabled: true } })
 * @returns {object} Client with `chat` and `models` methods
 */
export function createClient(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const model = resolveConfiguredModel(options.model);
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headers = options.headers || {};
  const extraBody = options.extraBody || {};

  return { chat, models, resolveModel, contextInfo, richModels };

  /**
   * Send a chat completion request with optional tool definitions.
   * Streams the response, emitting tokens as they arrive.
   * Returns the complete message when done.
   *
   * @param {object} params
   * @param {Array} params.messages - Chat messages
   * @param {Array} [params.tools] - Tool definitions
   * @param {function} [params.onToken] - Called with each text token
   * @param {function} [params.onToolCall] - Called when a tool call starts
   * @param {number} [params.timeoutMs] - Per-call timeout override (e.g. the
   *   run's remaining budget), so a request started near the run deadline
   *   doesn't get a fresh full-length timeout. Falls back to the client's
   *   configured timeout when omitted.
   * @param {number} [params.heartbeatMs] - Interval for onHeartbeat "still
   *   waiting" notices while a request is in flight (0 or omitted disables).
   *   A large prompt can spend minutes in prefill before the first token
   *   streams, which looks identical to a stuck request from the outside.
   * @param {function} [params.onHeartbeat] - Called with elapsed ms on each
   *   heartbeat tick
   * @param {function} [params.onDebug] - Called once per HTTP attempt with
   *   { url, requestBody, rawResponse, error? } -- the exact request sent and
   *   the raw, unparsed response text, for diagnosing a malformed response
   *   after the fact. A retried request calls this once per attempt.
   * @returns {Promise<{ message: object, usage: object, retries: number }>}
   */
  async function chat(params) {
    const body = {
      model: params.model || model,
      messages: params.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...extraBody,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: 'function',
        function: t,
      }));
    }

    const callTimeout = params.timeoutMs ?? timeout;
    return streamRequestWithRetry(
      `${baseUrl}/chat/completions`,
      body,
      callTimeout,
      {
        onToken: params.onToken,
        onToolCall: params.onToolCall,
        heartbeatMs: params.heartbeatMs,
        onHeartbeat: params.onHeartbeat,
        onDebug: params.onDebug,
      },
      maxRetries,
      headers,
    );
  }

  /**
   * List available models.
   * @returns {Promise<Array<{ id: string }>>}
   */
  async function models() {
    const data = await jsonRequest(`${baseUrl}/models`, timeout, headers);
    return data.data || [];
  }

  /**
   * Resolve which model to use. If one was configured, use it.
   * Otherwise pick the first loaded model from LM Studio.
   * @returns {Promise<string>}
   */
  async function resolveModel() {
    if (model) {
      return model;
    }
    const list = await models();
    if (list.length === 0) {
      return 'default';
    }
    return list[0].id;
  }

  /**
   * The full `/api/v0/models` listing — LM Studio's richer endpoint that
   * (unlike the OpenAI-compatible `/v1/models`) reports each model's state and
   * loaded/max context lengths. Returns an empty array when the endpoint is
   * absent or unreachable, so callers can degrade gracefully.
   * @returns {Promise<Array>}
   */
  async function richModels() {
    try {
      const origin = new URL(baseUrl).origin;
      const data = await jsonRequest(`${origin}/api/v0/models`, timeout);
      return data.data || [];
    } catch {
      return [];
    }
  }

  /**
   * Probe the context window the model is actually loaded with, plus the
   * model's maximum supported window. Both fields are null when unknown, so
   * callers can fall back to a default.
   * @param {string} modelId
   * @returns {Promise<{ loaded: number|null, max: number|null }>}
   */
  async function contextInfo(modelId) {
    return pickContextInfo(await richModels(), modelId);
  }
}

/**
 * Pick the loaded and max context lengths for a model from an `/api/v0/models`
 * listing. Prefers the entry matching modelId; otherwise falls back to any
 * loaded model (the one actually serving requests).
 * @param {Array} models - The `data` array from /api/v0/models
 * @param {string} modelId
 * @returns {{ loaded: number|null, max: number|null }}
 */
export function pickContextInfo(models, modelId) {
  const byId = models.find(
    (m) => m.id === modelId && Number.isInteger(m.loaded_context_length),
  );
  const chosen =
    byId ||
    models.find(
      (m) => m.state === 'loaded' && Number.isInteger(m.loaded_context_length),
    );
  if (!chosen) {
    return { loaded: null, max: null };
  }
  return {
    loaded: chosen.loaded_context_length,
    max: Number.isInteger(chosen.max_context_length)
      ? chosen.max_context_length
      : null,
  };
}

/**
 * Whether a model loaded at `loaded` tokens has meaningful unused headroom —
 * its max is at least HEADROOM_FACTOR times the loaded window, so reloading it
 * larger in LM Studio would buy a materially bigger context.
 * @param {number|null} loaded
 * @param {number|null} max
 * @returns {boolean}
 */
export function hasContextHeadroom(loaded, max) {
  if (!Number.isInteger(loaded) || !Number.isInteger(max) || loaded <= 0) {
    return false;
  }
  return max >= loaded * HEADROOM_FACTOR;
}

export const HEADROOM_FACTOR = 2;

function resolveConfiguredModel(model) {
  if (model) {
    return model;
  }
  return process.env.KODR_MODEL || '';
}

// --- streaming ---

/**
 * Stateful assembler for streamed chat completion chunks.
 * Accumulates content, reasoning, and tool calls, invoking callbacks as
 * deltas arrive.
 */
function createAssembler(onToken, onToolCall) {
  let role = 'assistant';
  let content = '';
  let reasoning = '';
  const reasoningDetails = [];
  const toolCalls = [];
  let usage = { prompt: 0, completion: 0, cost: 0 };

  function push(chunk) {
    // A provider's final chunk can carry `usage` alongside a (near-empty)
    // delta rather than in its own delta-less chunk (observed on
    // OpenRouter) -- check independently of whether delta is present, so
    // usage isn't silently dropped depending on chunk shape.
    if (chunk.usage) {
      usage = {
        prompt: chunk.usage.prompt_tokens || 0,
        completion: chunk.usage.completion_tokens || 0,
        // OpenRouter reports actual USD cost on usage.cost; LM Studio (a
        // local backend) has none, so this stays 0 -- an accurate "free"
        // rather than an unknown/null.
        cost: Number.isFinite(chunk.usage.cost) ? chunk.usage.cost : 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      return;
    }

    if (delta.role) {
      role = delta.role;
    }

    if (delta.content) {
      content += delta.content;
      if (onToken) {
        onToken(delta.content);
      }
    }

    if (delta.reasoning) {
      reasoning += delta.reasoning;
    }

    if (delta.reasoning_details) {
      reasoningDetails.push(...delta.reasoning_details);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        pushToolCall(toolCalls, tc, onToolCall);
      }
    }
  }

  function result() {
    const message = { role, content };
    if (reasoning) {
      message.reasoning = reasoning;
    }
    if (reasoningDetails.length > 0) {
      message.reasoning_details = reasoningDetails;
    }
    // A provider can stream tool-call deltas with a gap in `index` (0 then 2),
    // which leaves a hole in this sparse array. `.map` preserves holes and a
    // later `for..of` over message.tool_calls would yield `undefined` for
    // them, crashing the tool loop on `tc.function`. Drop holes so the array
    // is dense and every entry is a real call.
    const dense = toolCalls.filter((tc) => tc);
    if (dense.length > 0) {
      message.tool_calls = dense.map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return { message, usage };
  }

  return { push, result };
}

function pushToolCall(toolCalls, tc, onToolCall) {
  const idx = tc.index ?? toolCalls.length;
  if (!toolCalls[idx]) {
    toolCalls[idx] = { id: '', name: '', arguments: '' };
  }
  const call = toolCalls[idx];

  // A tool call streams across chunks: the name arrives once, arguments
  // accumulate, and the id may land in any chunk. Fill each field as it first
  // appears. onToolCall fires on the chunk that names the call.
  if (tc.function?.name && !call.name) {
    call.name = tc.function.name;
    if (onToolCall) {
      onToolCall(call.name);
    }
  }
  if (tc.function?.arguments) {
    call.arguments += tc.function.arguments;
  }
  if (tc.id && !call.id) {
    call.id = tc.id;
  }
}

/**
 * Assemble a complete response from an array of chunks.
 * Pure helper used by tests; the live path streams via createAssembler.
 */
export function assembleResponse(chunks, onToken, onToolCall) {
  const assembler = createAssembler(onToken, onToolCall);
  for (const chunk of chunks) {
    assembler.push(chunk);
  }
  return assembler.result();
}

// --- HTTP helpers ---

function transportFor(url) {
  return url.protocol === 'https:' ? httpsRequest : httpRequest;
}

function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed?.startsWith('data: ')) {
    return null;
  }
  const payload = trimmed.slice(6);
  if (payload === '[DONE]') {
    return null;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Retry a chat completion on a 5xx response or a connection reset/broken
 * pipe -- local backends (LM Studio) occasionally crash mid-request on an
 * otherwise-valid conversation (e.g. an internal JSON re-parse failure), and
 * a bare retry of the same request often just works, whether the crash
 * surfaced as an HTTP 500 or a dropped socket. 4xx, ECONNREFUSED, and
 * timeout errors are never retried: a 4xx would fail identically again,
 * ECONNREFUSED means nothing is listening at all (a persistent problem, not
 * a transient crash), and a timeout already means the model used the full
 * budget on that attempt.
 * @param {number} maxRetries - Extra attempts after the first (0 disables)
 * @returns {Promise<{ message: object, usage: object, retries: number }>} The
 *   `retries` field reports how many retries were actually used (0 when the
 *   first attempt succeeded), so a flaky-backend pattern is visible in the
 *   run record rather than only in live stderr. When every attempt fails,
 *   the thrown Error carries the same count as its own `retries` field.
 */
async function streamRequestWithRetry(
  url,
  body,
  timeout,
  callbacks,
  maxRetries,
  headers = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await streamRequest(
        url,
        body,
        timeout,
        callbacks,
        headers,
      );
      return { ...result, retries: attempt };
    } catch (err) {
      if (attempt === maxRetries || !isRetryableError(err)) {
        err.retries = attempt;
        throw err;
      }
      lastErr = err;
    }
  }
  lastErr.retries = maxRetries;
  throw lastErr;
}

function isRetryableError(err) {
  return isRetryableServerError(err) || isRetryableConnectionError(err);
}

/**
 * Whether an error from streamRequest is a 5xx HTTP status -- the class of
 * failure a local backend crash produces, as opposed to a 4xx (a bad request
 * that would fail the same way again) or a timeout.
 * @param {Error} err
 * @returns {boolean}
 */
export function isRetryableServerError(err) {
  return /^HTTP 5\d\d:/.test(err.message);
}

const RETRYABLE_CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE']);

/**
 * Whether an error from streamRequest is a connection reset or broken pipe --
 * the socket-level equivalent of a 5xx: the backend accepted the connection
 * and then dropped it mid-request (a crash, or a restart), as opposed to
 * ECONNREFUSED (nothing listening at all -- a persistent problem no retry
 * fixes) or a timeout (already used the full budget on that attempt).
 * @param {Error} err
 * @returns {boolean}
 */
export function isRetryableConnectionError(err) {
  return RETRYABLE_CONNECTION_ERROR_CODES.has(err.code);
}

function streamRequest(url, body, timeout, callbacks, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const assembler = createAssembler(callbacks.onToken, callbacks.onToolCall);
    let settled = false;
    let req;
    let rawResponse = '';
    const requestStartedAt = Date.now();
    let heartbeatTimer;
    if (callbacks.heartbeatMs > 0 && callbacks.onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        callbacks.onHeartbeat(Date.now() - requestStartedAt);
      }, callbacks.heartbeatMs);
    }

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (callbacks.onDebug) {
        callbacks.onDebug({
          url,
          requestBody: body,
          rawResponse,
          error: fn === reject ? value.message : undefined,
        });
      }
      fn(value);
    }

    const hardTimer = setTimeout(() => {
      if (req) {
        req.destroy();
      }
      finish(reject, new Error(`Request timed out after ${timeout}ms`));
    }, timeout);

    req = transportFor(parsed)(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 400) {
          res.on('data', (c) => {
            rawResponse += c;
          });
          res.on('end', () =>
            finish(reject, new Error(`HTTP ${res.statusCode}: ${rawResponse}`)),
          );
          return;
        }

        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (text) => {
          rawResponse += text;
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const chunk = parseSseLine(line);
            if (chunk) {
              assembler.push(chunk);
            }
          }
        });

        res.on('end', () => {
          const chunk = parseSseLine(buffer);
          if (chunk) {
            assembler.push(chunk);
          }
          finish(resolve, assembler.result());
        });

        res.on('error', (err) => finish(reject, err));
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish(reject, new Error(`Request timed out after ${timeout}ms`));
    });

    req.on('error', (err) => {
      finish(reject, err);
    });
    req.write(payload);
    req.end();
  });
}

function jsonRequest(url, timeout, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    let settled = false;
    let req;
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (req) {
        req.destroy();
      }
      reject(new Error(`Request timed out after ${timeout}ms`));
    }, timeout);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn(value);
    }

    req = transportFor(parsed)(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        headers: { ...headers, Accept: 'application/json' },
        timeout,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            finish(reject, new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            finish(resolve, JSON.parse(data));
          } catch (e) {
            finish(reject, new Error(`Invalid JSON: ${e.message}`));
          }
        });
        res.on('error', (err) => finish(reject, err));
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish(reject, new Error(`Request timed out after ${timeout}ms`));
    });

    req.on('error', (err) => {
      if (settled) return;
      finish(reject, err);
    });
    req.end();
  });
}
