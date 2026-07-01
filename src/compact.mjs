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
const MAX_TOOL_RESULT_CHARS = 2000;

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
 * message is skipped (it is preserved separately). Tool results are truncated
 * so a single huge read does not dominate the summary input.
 * @param {Array} messages
 * @returns {string}
 */
export function renderTranscript(messages) {
  const lines = [];
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'user') {
      lines.push(`User:\n${message.content || ''}`);
    } else if (message.role === 'assistant') {
      if (message.content) {
        lines.push(`Assistant:\n${message.content}`);
      }
      for (const call of message.tool_calls || []) {
        lines.push(
          `Assistant called ${call.function.name}(${call.function.arguments})`,
        );
      }
    } else if (message.role === 'tool') {
      lines.push(`Tool result:\n${truncate(message.content || '')}`);
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
 * @returns {Promise<{ messages: Array, summary: string, usage: { prompt: number, completion: number }, error?: string }>}
 */
export async function compactMessages(params) {
  const { client, modelId, messages, quiet = false, timeoutMs } = params;
  const system = messages.find((message) => message.role === 'system') || null;
  const history = messages.filter((message) => message.role !== 'system');

  if (history.length === 0) {
    return { messages: messages.slice(), summary: '', usage: zeroUsage() };
  }

  const transcript = renderTranscript(history);
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
    });
  } catch (err) {
    return {
      messages: messages.slice(),
      summary: '',
      usage: zeroUsage(),
      error: err.message,
    };
  }

  const summary = (response.message.content || '').trim();
  if (!summary) {
    return {
      messages: messages.slice(),
      summary: '',
      usage: response.usage || zeroUsage(),
      error: 'empty summary',
    };
  }

  return {
    messages: buildCompacted(system, summary),
    summary,
    usage: response.usage || zeroUsage(),
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

function truncate(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated]`;
}

function zeroUsage() {
  return { prompt: 0, completion: 0 };
}
