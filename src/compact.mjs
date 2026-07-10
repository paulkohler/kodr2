/**
 * Conversation compaction.
 *
 * When a run's context approaches the model's window, the older message
 * history is summarized into a single dense message so work can continue.
 * The system prompt stays intact and tool definitions are supplied fresh on
 * every model call, so only the non-system message history is compressed.
 */

export const COMPACTION_THRESHOLD = 0.8;
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_COMPACT_MESSAGE_CHARS = 2000;
export const DEFAULT_COMPACT_TASK_CHARS = 8000;
export const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate for a message history, used only as a fallback when the
 * provider does not report prompt-token usage (e.g. Ollama's /v1 endpoint).
 * Without it, needsCompaction sees promptTokens 0 and auto-compaction never
 * fires, so a long session grows unbounded until the backend truncates or
 * errors. A chars/token heuristic is deliberately crude -- it only has to be
 * good enough to cross the compaction threshold before the real window does.
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

const SUMMARY_SYSTEM = `You are compacting a long coding session so it can continue with a smaller context window. Produce a dense, factual summary of the work so far. Preserve, in order:
- The original task and goal.
- Key decisions, approaches, and constraints discovered.
- Every file created or modified, and what changed in each.
- Important findings from reading files or running commands (test output, errors).
- The current state and the concrete next steps that remain.
Write only the summary. No preamble, no closing remarks.`;

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
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'user') {
      // An image user message (from view_image) has array content, not a
      // string -- render a compact placeholder instead of truncating it.
      if (Array.isArray(message.content)) {
        lines.push(`User:\n${imagePlaceholder(message.content)}`);
        taskSeen = true;
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
    } else if (message.role === 'assistant') {
      if (message.content) {
        lines.push(`Assistant:\n${truncate(message.content, maxChars)}`);
      }
      for (const call of message.tool_calls || []) {
        const args = truncate(call.function.arguments || '', maxChars);
        lines.push(`Assistant called ${call.function.name}(${args})`);
      }
    } else if (message.role === 'tool') {
      lines.push(`Tool result:\n${truncate(message.content || '', maxChars)}`);
    }
  }
  return lines.join('\n\n');
}

/**
 * Compact a conversation: keep the system message, summarize the history into
 * one message, and return the new conversation. On failure the original
 * messages are returned unchanged with an `error`.
 * @param {object} params
 * @param {object} params.client - Model client
 * @param {string} params.modelId - Model to summarize with
 * @param {Array} params.messages - Conversation so far
 * @param {boolean} [params.quiet] - Suppress streamed summary output
 * @param {number} [params.timeoutMs] - Per-call timeout override (e.g. the run's remaining budget)
 * @param {number} [params.heartbeatMs] - Interval for onHeartbeat "still waiting" notices (0 disables)
 * @param {function} [params.onHeartbeat] - Called with elapsed ms on each heartbeat tick
 * @param {function} [params.onDebug] - Forwarded to the summary chat call (see specs/debug-log.yaml)
 * @param {number} [params.maxMessageChars] - Per-message cap for the rendered transcript
 *   (also KODR_COMPACT_MESSAGE_CHARS; default 2000), so the summarize request stays
 *   smaller than the conversation that triggered compaction
 * @param {number} [params.maxTaskChars] - Cap for the first user (task) message
 *   (also KODR_COMPACT_TASK_CHARS; default 8000), a larger bound than other
 *   messages but still bounded so a huge task prompt can't overflow the request
 * @returns {Promise<{ messages: Array, summary: string, usage: { prompt: number, completion: number }, retries: number, error?: string }>}
 */
export async function compactMessages(params) {
  const { client, modelId, messages, quiet = false, timeoutMs } = params;
  const { heartbeatMs, onHeartbeat, onDebug } = params;
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
      onToken: quiet ? undefined : (token) => process.stdout.write(token),
      timeoutMs,
      heartbeatMs,
      onHeartbeat,
      onDebug,
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

  return {
    messages: buildCompacted(system, summary),
    summary,
    usage: response.usage || zeroUsage(),
    retries: response.retries || 0,
  };
}

function buildCompacted(system, summary) {
  const compacted = [];
  if (system) {
    compacted.push(system);
  }
  compacted.push({
    role: 'user',
    content: `<session-summary>\n${summary}\n</session-summary>\n\nThe detailed history of this session was compacted to save context. The summary above is the current state. Continue the task from here.`,
  });
  return compacted;
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}… [truncated]`;
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
