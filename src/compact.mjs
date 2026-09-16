/**
 * Conversation compaction.
 *
 * When a run's context approaches the model's window, the older message
 * history is summarized into a single dense message so work can continue.
 * The system prompt stays intact and tool definitions are supplied fresh on
 * every model call, so only the non-system message history is compressed.
 */

import { loadPrompt } from './prompts.mjs';

export const COMPACTION_THRESHOLD = 0.8;
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_COMPACT_MESSAGE_CHARS = 2000;
export const DEFAULT_COMPACT_TASK_CHARS = 8000;
export const DEFAULT_COMPACT_RECENT_CHARS = 4000;
export const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate for a message history. Two consumers: the fallback
 * when the provider reports no prompt-token usage (e.g. Ollama's /v1
 * endpoint) -- without it, needsCompaction sees promptTokens 0 and
 * auto-compaction never fires -- and the post-turn compaction check, whose
 * reported usage measures the request *before* the turn's tool results were
 * appended and so alone would lag one turn behind the largest additions. A
 * chars/token heuristic is deliberately crude -- it only has to be good
 * enough to cross the compaction threshold before the real window does.
 * @param {Array} messages
 * @param {number} [charsPerToken] - Overridable estimation ratio
 * @returns {number} Estimated prompt tokens
 */
export function estimateTokens(messages, charsPerToken = CHARS_PER_TOKEN) {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      chars += message.content.length;
    }
    // A reasoning model's scratchpad is replayed to the provider on every
    // turn like any other part of the message, so it costs prompt tokens --
    // and since model.mjs now moves inline <think> text out of content and
    // onto this field, leaving it uncounted would make the estimate
    // structurally worse for exactly the models that produce the most of it.
    if (typeof message.reasoning === 'string') {
      chars += message.reasoning.length;
    }
    for (const call of message.tool_calls || []) {
      chars += (call.function?.name || '').length;
      chars += (call.function?.arguments || '').length;
    }
  }
  return Math.ceil(chars / charsPerToken);
}

/**
 * Per-message character cap applied when flattening the transcript for
 * summarization. Compaction fires precisely because the live context is near
 * the window, so the summarize request has to be smaller than what triggered
 * it -- bounding each rendered message keeps one huge paste, tool result, or
 * reasoning dump from pushing the summarize call back over the same window and
 * into a fail-and-retry loop. Overridable (per AGENTS.md) via an option, then
 * KODR_COMPACT_MESSAGE_CHARS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function compactMessageChars(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(
    process.env.KODR_COMPACT_MESSAGE_CHARS || '',
    10,
  );
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_COMPACT_MESSAGE_CHARS;
}

/**
 * Per-message character cap for the first user (task) message. The task is kept
 * at a larger bound than other messages because the summary is required to
 * preserve the original goal -- but it is still bounded, so a pathologically
 * large task prompt cannot by itself push the summarize request back over the
 * window that triggered compaction (which would leave the run stuck
 * over-window, unable to compact). Overridable via an option, then
 * KODR_COMPACT_TASK_CHARS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function compactTaskChars(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(
    process.env.KODR_COMPACT_TASK_CHARS || '',
    10,
  );
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_COMPACT_TASK_CHARS;
}

/**
 * Total character cap for mechanically retained recent tool state.
 * @param {number} [option]
 * @returns {number}
 */
export function compactRecentChars(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(
    process.env.KODR_COMPACT_RECENT_CHARS || '',
    10,
  );
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_COMPACT_RECENT_CHARS;
}

const SUMMARY_SYSTEM = loadPrompt('compact');

/**
 * The explicitly configured context window in tokens, from an option value or
 * the KODR_CONTEXT_WINDOW env var. Returns null when neither is set, letting
 * the caller probe the model or fall back to a default. A value of 0 is a valid
 * explicit setting that disables auto-compaction.
 * @param {number} [value]
 * @returns {number|null}
 */
export function configuredContextWindow(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  const fromEnv = parseInt(process.env.KODR_CONTEXT_WINDOW || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return null;
}

/**
 * Whether the live context has crossed the compaction threshold.
 * @param {number} promptTokens - Prompt-token count of the most recent request
 * @param {number} contextWindow - Max context window (0 disables)
 * @param {number} [threshold] - Fraction of the window that triggers compaction
 * @returns {boolean}
 */
export function needsCompaction(
  promptTokens,
  contextWindow,
  threshold = COMPACTION_THRESHOLD,
) {
  if (!contextWindow || contextWindow <= 0) {
    return false;
  }
  if (!promptTokens || promptTokens <= 0) {
    return false;
  }
  return promptTokens >= contextWindow * threshold;
}

/**
 * Whether a prompt is the on-demand compaction command.
 * @param {string} prompt
 * @returns {boolean}
 */
export function isCompactCommand(prompt) {
  return typeof prompt === 'string' && prompt.trim() === '/compact';
}

/**
 * Flatten a message history into plain text for summarization. The system
 * message is skipped (it is preserved separately). The first user message (the
 * original task/goal) is truncated to `taskMaxChars` -- a larger bound than
 * other content, since the summary must preserve the goal, but still bounded so
 * a pathologically large task prompt can't alone push the summarize request
 * back over the window. Every other message -- later user turns, assistant
 * text, tool call arguments, and tool results -- is truncated to `maxChars`.
 *
 * An assistant turn (its tool calls plus the tool results that answer them) is
 * collapsed to a single instance plus a repeat count when it renders
 * byte-identical to the immediately preceding turn -- e.g. the same failing
 * call retried unchanged, or the same read repeated to recheck state. This
 * keeps the "this was tried and failed" signal (unlike dropping errors
 * outright, which would erase the one thing a summary needs to warn against
 * repeating) while not burning summarize-request budget re-rendering the same
 * text over and over.
 * @param {Array} messages
 * @param {number} [maxChars] - Per-message cap for non-task content
 * @param {number} [taskMaxChars] - Cap for the first user (task) message
 * @returns {string}
 */
export function renderTranscript(
  messages,
  maxChars = compactMessageChars(),
  taskMaxChars = compactTaskChars(),
) {
  const lines = [];
  let taskSeen = false;
  let lastTurnText = null;
  let identicalRepeats = 0;

  function flushRepeats() {
    if (identicalRepeats > 0) {
      let suffix = 's';
      if (identicalRepeats === 1) {
        suffix = '';
      }
      lines.push(
        `(same tool call and result repeated identically ${identicalRepeats} more time${suffix})`,
      );
      identicalRepeats = 0;
    }
  }

  let i = 0;
  while (i < messages.length) {
    const message = messages[i];

    if (message.role === 'system') {
      i++;
      continue;
    }

    if (message.role === 'user') {
      flushRepeats();
      lastTurnText = null;
      // An image user message (from view_image) has array content, not a
      // string -- render a compact placeholder instead of truncating it.
      if (Array.isArray(message.content)) {
        lines.push(`User:\n${imagePlaceholder(message.content)}`);
        taskSeen = true;
        i++;
        continue;
      }
      const content = message.content || '';
      let rendered;
      if (taskSeen) {
        rendered = truncate(content, maxChars);
      } else {
        rendered = truncate(content, taskMaxChars);
      }
      lines.push(`User:\n${rendered}`);
      taskSeen = true;
      i++;
      continue;
    }

    if (message.role === 'assistant') {
      const turnLines = [];
      if (message.content) {
        turnLines.push(`Assistant:\n${truncate(message.content, maxChars)}`);
      }
      for (const call of message.tool_calls || []) {
        const args = truncate(call.function.arguments || '', maxChars);
        turnLines.push(`Assistant called ${call.function.name}(${args})`);
      }
      i++;
      // The tool results answering this turn's calls immediately follow it --
      // fold them into the same turn so a retried call and its (also
      // repeated) result collapse together, not as two independent lines.
      while (i < messages.length && messages[i].role === 'tool') {
        turnLines.push(
          `Tool result:\n${truncate(messages[i].content || '', maxChars)}`,
        );
        i++;
      }
      if (turnLines.length === 0) {
        continue;
      }
      const turnText = turnLines.join('\n\n');
      if (turnText === lastTurnText) {
        identicalRepeats++;
        continue;
      }
      flushRepeats();
      lines.push(turnText);
      lastTurnText = turnText;
      continue;
    }

    // A lone tool message with no preceding assistant call in this slice
    // (not expected in a well-formed conversation, but rendered rather than
    // silently dropped).
    flushRepeats();
    lastTurnText = null;
    lines.push(`Tool result:\n${truncate(message.content || '', maxChars)}`);
    i++;
  }
  flushRepeats();

  return lines.join('\n\n');
}

/**
 * Render the most recent completed assistant tool turn and its results. This
 * state is retained mechanically beside the generated summary, so a summary
 * that overemphasizes the original task cannot erase the latest completed
 * action. The returned text has one total cap, independent of call count.
 * @param {Array} messages
 * @param {number} [maxChars]
 * @returns {string}
 */
export function renderRecentToolState(
  messages,
  maxChars = compactRecentChars(),
) {
  let end = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'tool') {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return '';
  }

  let start = end;
  while (start >= 0 && messages[start].role === 'tool') {
    start--;
  }
  const assistant = messages[start];
  const calls = assistant?.tool_calls || [];
  if (assistant?.role !== 'assistant' || calls.length === 0) {
    return '';
  }

  const results = messages.slice(start + 1, end + 1);
  if (!toolTurnComplete(calls, results)) {
    return '';
  }

  return truncateTotal(
    renderTranscript(messages.slice(start, end + 1), maxChars, maxChars),
    maxChars,
  );
}

function toolTurnComplete(calls, results) {
  if (results.length < calls.length) {
    return false;
  }
  const callIds = calls.map((call) => call.id).filter(Boolean);
  if (callIds.length !== calls.length) {
    return true;
  }
  const resultIds = new Set(results.map((result) => result.tool_call_id));
  return callIds.every((id) => resultIds.has(id));
}

/**
 * Compact a conversation: keep the system message, summarize the history into
 * one message, and return the new conversation. On failure the original
 * messages are returned unchanged with an `error`.
 * @param {object} params
 * @param {import('./provider.mjs').Provider} params.client - Model client
 * @param {string} params.modelId - Model to summarize with
 * @param {Array} params.messages - Conversation so far
 * @param {import('./reporter.mjs').Reporter} [params.reporter] - Output channel for the streamed summary
 *   (see specs/reporter.yaml); defaults to a null (silent) reporter
 * @param {number} [params.timeoutMs] - Per-call timeout override (e.g. the run's remaining budget)
 * @param {number} [params.heartbeatMs] - Interval for onHeartbeat "still waiting" notices (0 disables)
 * @param {function} [params.onHeartbeat] - Called with elapsed ms on each heartbeat tick
 * @param {function} [params.onDebug] - Forwarded to the summary chat call (see specs/debug-log.yaml)
 * @param {AbortSignal} [params.signal] - Cancellation signal forwarded to the summary chat call
 * @param {number} [params.maxMessageChars] - Per-message cap for the rendered transcript
 *   (also KODR_COMPACT_MESSAGE_CHARS; default 2000), so the summarize request stays
 *   smaller than the conversation that triggered compaction
 * @param {number} [params.maxTaskChars] - Cap for the first user (task) message
 *   (also KODR_COMPACT_TASK_CHARS; default 8000), a larger bound than other
 *   messages but still bounded so a huge task prompt can't overflow the request
 * @param {number} [params.maxRecentChars] - Total cap for the mechanically
 *   retained most recent completed tool turn (also KODR_COMPACT_RECENT_CHARS;
 *   default 4000)
 * @returns {Promise<{ messages: Array, summary: string, usage: { prompt: number, completion: number, cost: number }, retries: number, error?: string }>}
 */
export async function compactMessages(params) {
  const { client, modelId, messages, reporter, timeoutMs } = params;
  const { heartbeatMs, onHeartbeat, onDebug, signal } = params;
  const system = messages.find((message) => message.role === 'system') || null;
  const history = messages.filter((message) => message.role !== 'system');

  if (history.length === 0) {
    return {
      messages: messages.slice(),
      summary: '',
      usage: zeroUsage(),
      retries: 0,
    };
  }

  const transcript = renderTranscript(
    history,
    compactMessageChars(params.maxMessageChars),
    compactTaskChars(params.maxTaskChars),
  );
  let response;
  try {
    response = await client.chat({
      model: modelId,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: `Summarize this coding session:\n\n${transcript}`,
        },
      ],
      onToken: (token) => reporter?.token(token),
      timeoutMs,
      heartbeatMs,
      onHeartbeat,
      onDebug,
      signal,
    });
  } catch (err) {
    return {
      messages: messages.slice(),
      summary: '',
      usage: zeroUsage(),
      retries: err.retries ?? 0,
      error: err.message,
    };
  }

  const summary = (response.message.content || '').trim();
  if (!summary) {
    return {
      messages: messages.slice(),
      summary: '',
      usage: response.usage || zeroUsage(),
      retries: response.retries || 0,
      error: 'empty summary',
    };
  }

  const recentState = renderRecentToolState(
    history,
    compactRecentChars(params.maxRecentChars),
  );
  return {
    messages: buildCompacted(system, summary, recentState),
    summary,
    usage: response.usage || zeroUsage(),
    retries: response.retries || 0,
  };
}

function buildCompacted(system, summary, recentState) {
  const compacted = [];
  if (system) {
    compacted.push(system);
  }
  let content = `<session-summary>\n${summary}\n</session-summary>`;
  if (recentState) {
    content += `\n\n<recent-tool-state>\n${recentState}\n</recent-tool-state>`;
  }
  content +=
    '\n\nThe detailed history was compacted. The mechanically retained recent tool state is authoritative over the generated summary. Continue from the current next action; do not restart the original task or repeat completed tool calls unless a fresh result is required.';
  compacted.push({
    role: 'user',
    content,
  });
  return compacted;
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}… [truncated]`;
}

function truncateTotal(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = '… [truncated]';
  if (maxChars <= suffix.length) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

/**
 * Render an image user message (array content) as a short placeholder: the
 * text label, if any, plus an [image] marker -- never the base64 data URI.
 * @param {Array} parts - OpenAI-style content parts
 * @returns {string}
 */
function imagePlaceholder(parts) {
  const labels = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      labels.push(part.text);
    } else if (part.type === 'image_url') {
      labels.push('[image]');
    }
  }
  return labels.join(' ') || '[image]';
}

function zeroUsage() {
  return { prompt: 0, completion: 0, cost: 0 };
}
