/**
 * ACP protocol plumbing — pure and I/O-free (see specs/acp.yaml).
 *
 * The transport (JSON-RPC 2.0 over stdio) lives in the imperative shell
 * (src/acp.mjs); everything here is a plain function or a factory whose only
 * side effect is calling an injected `send`, so it is fully unit-testable
 * without a real socket, subprocess, or the model. This mirrors the reporter
 * precedent (src/reporter.mjs): a factory over an injected sink.
 */

/**
 * The ACP protocol version Kodr speaks. A single integer; if a client asks for
 * a different version it still gets this one and downgrades on its side.
 */
export const PROTOCOL_VERSION = 1;

// JSON-RPC 2.0 error codes used by the connection below.
export const PARSE_ERROR = -32700;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

/**
 * Translate a Kodr RunResult.stoppedReason (plus whether the session was
 * cancelled) into an ACP StopReason. A cancelled session wins over whatever
 * the run happened to report, since the client asked for the stop.
 * @param {string} stoppedReason
 * @param {boolean} [cancelled]
 * @returns {string}
 */
export function stopReasonFor(stoppedReason, cancelled) {
  if (cancelled || stoppedReason === 'cancelled') {
    return 'cancelled';
  }
  if (stoppedReason === 'complete') {
    return 'end_turn';
  }
  if (stoppedReason === 'budget-exceeded' || stoppedReason === 'tool-limit') {
    return 'max_turn_requests';
  }
  if (stoppedReason === 'error') {
    return 'refusal';
  }
  return 'end_turn';
}

/**
 * The agentCapabilities Kodr advertises at initialize. Deliberately honest
 * about what this version implements rather than aspirational: no cross-process
 * session resume, text prompts only.
 * @returns {object}
 */
export function agentCapabilities() {
  return {
    loadSession: false,
    promptCapabilities: {
      image: false,
      audio: false,
      embeddedContext: false,
    },
  };
}

/**
 * The full initialize result: the negotiated protocol version, capabilities,
 * and an empty auth-method list (Kodr needs no ACP-level auth; provider keys
 * come from the environment).
 * @returns {object}
 */
export function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: agentCapabilities(),
    authMethods: [],
  };
}

/**
 * Concatenate the text from an ACP prompt's content blocks. Only `text` blocks
 * contribute in this version; other block types (image, resource) are ignored.
 * @param {Array<{ type: string, text?: string }>} [contentBlocks]
 * @returns {string}
 */
export function extractPromptText(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return '';
  }
  const parts = [];
  for (const block of contentBlocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * The ACP ToolKind for a Kodr tool name, for the tool_call update's `kind`.
 * Unknown names fall back to "other".
 * @param {string} name
 * @returns {string}
 */
export function toolKindFor(name) {
  if (name === 'read_file' || name === 'list_files' || name === 'search') {
    return 'read';
  }
  if (name === 'view_image') {
    return 'read';
  }
  if (name === 'write_file' || name === 'edit_file') {
    return 'edit';
  }
  if (name === 'run_command') {
    return 'execute';
  }
  return 'other';
}

/**
 * A minimal JSON-RPC 2.0 connection. Transport-agnostic: `send` writes one
 * message object out (the shell serializes it to a line). `receive` is fed one
 * parsed incoming message object at a time.
 *
 * Routing by shape:
 *   - method + id            -> a request; dispatch to a handler and respond.
 *   - method, no id          -> a notification; dispatch, no response.
 *   - id + result/error      -> a response to a request we sent; settle it.
 *
 * @param {{ send: (message: object) => void }} params
 * @returns {{
 *   notify: (method: string, params?: object) => void,
 *   request: (method: string, params?: object) => Promise<any>,
 *   setHandler: (method: string, handler: (params: any) => any) => void,
 *   receive: (message: object) => Promise<void>,
 * }}
 */
export function createJsonRpcConnection(params) {
  const { send } = params;
  const handlers = new Map();
  const pending = new Map();
  let nextId = 1;

  function notify(method, methodParams) {
    send({ jsonrpc: '2.0', method, params: methodParams ?? {} });
  }

  function request(method, methodParams) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params: methodParams ?? {} });
    });
  }

  function setHandler(method, handler) {
    handlers.set(method, handler);
  }

  async function receive(message) {
    if (isResponse(message)) {
      settleResponse(message);
      return;
    }
    if (typeof message.method !== 'string') {
      return;
    }
    if (message.id === undefined || message.id === null) {
      await dispatchNotification(message);
      return;
    }
    await dispatchRequest(message);
  }

  function settleResponse(message) {
    const waiter = pending.get(message.id);
    if (!waiter) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message || 'request failed'));
      return;
    }
    waiter.resolve(message.result);
  }

  async function dispatchNotification(message) {
    const handler = handlers.get(message.method);
    if (!handler) {
      return;
    }
    try {
      await handler(message.params ?? {});
    } catch {
      // A notification has no id to answer with an error response, and receive()
      // is fired without awaiting -- so a throwing handler would surface as an
      // unhandled rejection (fatal by default on Node 22). Swallow it here,
      // symmetric with how dispatchRequest turns a throw into an error response.
    }
  }

  async function dispatchRequest(message) {
    const handler = handlers.get(message.method);
    if (!handler) {
      send(errorResponse(message.id, METHOD_NOT_FOUND, 'method not found'));
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (err) {
      send(errorResponse(message.id, INTERNAL_ERROR, err.message));
    }
  }

  return { notify, request, setHandler, receive };
}

function isResponse(message) {
  const hasId = message.id !== undefined && message.id !== null;
  return hasId && ('result' in message || 'error' in message);
}

/**
 * Build a JSON-RPC error response object.
 * @param {number|string} id
 * @param {number} code
 * @param {string} message
 * @returns {object}
 */
export function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
