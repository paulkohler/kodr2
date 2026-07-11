/**
 * Recover tool calls a model emitted as assistant text instead of through the
 * native tool channel. A compatibility fallback only — native tool_calls are
 * always preferred and this runs only when a message carries none.
 *
 * Recovery is deterministic: it keys off explicit framings (the Mistral
 * `[TOOL_CALLS]` token, the `name[ARGS]{...}` form, JSON object/array forms,
 * fenced code blocks), never heuristics over prose. Recovered calls are
 * untrusted exactly like native ones and go through the same dispatch.
 */

const TOKEN = '[TOOL_CALLS]';

/**
 * Recover zero or more tool calls from assistant text, in emission order.
 * @param {string} content
 * @returns {Array<{ name: string, args: object }>}
 */
export function recoverToolCalls(content) {
  const text = (content || '').trim();
  if (!text) {
    return [];
  }

  // Mistral framing: parse only the segments after each [TOOL_CALLS] token, so
  // echoed prose or a prior tool result before the token is ignored.
  if (text.includes(TOKEN)) {
    const calls = [];
    for (const segment of text.split(TOKEN).slice(1)) {
      calls.push(...parsePayload(segment.trim()));
    }
    if (calls.length > 0) {
      return calls;
    }
  }

  // A fenced code block (```json / ```tool_call / ```tool_code / bare ```).
  const fenced = extractFenced(text);
  if (fenced) {
    const calls = parsePayload(fenced);
    if (calls.length > 0) {
      return calls;
    }
  }

  return parsePayload(text);
}

/**
 * Recover the real tool name from a native tool_call whose name field was
 * polluted with the Mistral framing — e.g. a model that echoed a prior result
 * and the `[TOOL_CALLS]` token into the function name:
 *   `{"written":true}[TOOL_CALLS]write_file`  ->  `write_file`
 *
 * Only acts on token-framed names (high confidence); a clean name or an
 * unframed-but-odd name is returned unchanged so dispatch can reject it.
 * @param {string} rawName
 * @returns {string}
 */
export function recoverToolName(rawName) {
  if (typeof rawName !== 'string' || isToolName(rawName)) {
    return rawName;
  }
  const idx = rawName.lastIndexOf(TOKEN);
  if (idx === -1) {
    return rawName;
  }
  const after = rawName.slice(idx + TOKEN.length).trim();
  const match = after.match(/^([a-z][a-z0-9_]*)/);
  if (match) {
    return match[1];
  }
  return rawName;
}

/**
 * Whether a native tool_call's `arguments` string is non-empty but not parseable
 * as JSON — the sign of a model that mis-escaped or truncated its arguments
 * (common with escaping-heavy content). An empty/whitespace value is a valid
 * no-argument call, not malformed.
 *
 * Storing such a raw message and replaying it can break the backend chat
 * template (observed: a deterministic HTTP 500 that aborts the run), so callers
 * repair the stored arguments to "{}" and ask the model to resend.
 * @param {*} value - tc.function.arguments
 * @returns {boolean}
 */
export function isUnparseableArgs(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

/**
 * First recovered call, or null. Back-compatible with the original single-call
 * recovery used by the tool loop and its tests.
 * @param {string} content
 * @returns {{ name: string, args: object } | null}
 */
export function recoverTextToolCall(content) {
  const calls = recoverToolCalls(content);
  if (calls.length === 0) {
    return null;
  }
  return calls[0];
}

function parsePayload(payload) {
  const p = payload.trim();
  if (!p) {
    return [];
  }

  const named = parseNamedCall(p);
  if (named.length > 0) {
    return named;
  }

  return parseJsonCalls(p);
}

/**
 * `name[ARGS]{...}` or `name{...}` / `name[...]` anchored at the payload start.
 * The bracket block is the arguments. Anchoring avoids matching prose.
 */
function parseNamedCall(p) {
  const match = p.match(/^([a-z][a-z0-9_]*)\s*(?:\[ARGS\]\s*)?([{[][\s\S]*)$/);
  if (!match) {
    return [];
  }
  const extracted = extractBalanced(match[2], 0);
  if (!extracted) {
    return [];
  }
  let args;
  try {
    args = JSON.parse(extracted);
  } catch {
    return [];
  }
  if (!isPlainObject(args)) {
    return [];
  }
  return [{ name: match[1], args }];
}

/**
 * A JSON object or array at the payload start, each carrying a tool name and
 * arguments under a recognized key.
 */
function parseJsonCalls(p) {
  if (p[0] !== '{' && p[0] !== '[') {
    return [];
  }
  const extracted = extractBalanced(p, 0);
  if (!extracted) {
    return [];
  }
  let value;
  try {
    value = JSON.parse(extracted);
  } catch {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(normalizeCall).filter(Boolean);
  }
  const call = normalizeCall(value);
  if (call) {
    return [call];
  }
  return [];
}

function normalizeCall(obj) {
  if (!isPlainObject(obj)) {
    return null;
  }
  const name = obj.name || obj.tool || obj.tool_name || obj.function;
  if (typeof name !== 'string' || !isToolName(name)) {
    return null;
  }
  const raw = firstDefined(obj.arguments, obj.args, obj.parameters, obj.input);
  const args = coerceArgs(raw);
  if (!isPlainObject(args)) {
    return null;
  }
  return { name, args };
}

function coerceArgs(raw) {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Slice the balanced `{...}` or `[...]` beginning at start, respecting strings
 * and escapes. Returns the JSON substring or null. Trailing text is ignored.
 */
export function extractBalanced(str, start) {
  const open = str[start];
  let close = ']';
  if (open === '{') {
    close = '}';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function extractFenced(text) {
  const match = text.match(/```[a-z_]*\s*\n?([\s\S]*?)```/i);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function isToolName(name) {
  return /^[a-z][a-z0-9_]*$/.test(name);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return !Array.isArray(value);
}
