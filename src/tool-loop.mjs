/**
 * The tool loop — the single agent turn loop shared by the main run and the
 * heal pass, so the two cannot diverge.
 *
 * Each turn: ask the model, stream its text, execute any tool calls (native
 * API calls first, then the text-form recovery fallback), and stop when the
 * model answers with no tool call, the run budget is spent, or the turn
 * ceiling is hit. Native API tool calls are the primary path; text-form
 * recovery is a narrow compatibility fallback for models that emit
 * `tool_name[ARGS]{...}` as assistant text after receiving tool results.
 */

import { formatToolCall, formatToolResult } from './format.mjs';

export const MAX_TOOL_TURNS = 20;

/**
 * Run the model/tool loop until it completes, exhausts its turn budget, or
 * hits the turn ceiling.
 * @param {object} params
 * @param {object} params.client - Model client
 * @param {string} params.modelId - Model to use
 * @param {Array} params.messages - Conversation so far (mutated in place)
 * @param {object} params.tools - Tool registry
 * @param {boolean} [params.quiet] - Suppress streamed output
 * @param {Date} [params.startedAt] - Run start, for the budget check
 * @param {number} [params.maxRunMs] - Stop between turns after this many ms (0 disables)
 * @returns {Promise<{ finalText: string, completed: boolean, stoppedReason: string, toolTurns: number, usage: { prompt: number, completion: number } }>}
 */
export async function runToolLoop(params) {
  const { client, modelId, messages, tools, quiet = false } = params;
  const { startedAt, maxRunMs = 0 } = params;

  const usage = { prompt: 0, completion: 0 };
  let toolTurns = 0;
  let finalText = '';
  let completed = false;
  let stoppedReason = 'tool-limit';

  while (toolTurns < MAX_TOOL_TURNS) {
    if (isRunBudgetExceeded(startedAt, maxRunMs)) {
      stoppedReason = 'budget-exceeded';
      break;
    }

    const { message, usage: turnUsage } = await client.chat({
      model: modelId,
      messages,
      tools: tools.definitions(),
      onToken: quiet ? undefined : (t) => process.stdout.write(t),
    });

    usage.prompt += turnUsage.prompt;
    usage.completion += turnUsage.completion;
    messages.push(message);

    const nativeCalls = await executeNativeToolCalls(
      message,
      tools,
      messages,
      quiet,
    );
    if (nativeCalls === 0) {
      const recovered = await executeRecoveredTextToolCall(
        message,
        tools,
        messages,
        quiet,
      );
      if (!recovered) {
        finalText = message.content || '';
        completed = true;
        stoppedReason = 'complete';
        if (!quiet) {
          process.stdout.write('\n');
        }
        break;
      }
    }

    toolTurns++;
    if (isRunBudgetExceeded(startedAt, maxRunMs)) {
      stoppedReason = 'budget-exceeded';
      break;
    }
  }

  return { finalText, completed, stoppedReason, toolTurns, usage };
}

/**
 * Whether the run has exceeded its wall-clock budget. A maxRunMs of 0 (or any
 * falsy value) disables the budget, so startedAt is never required then.
 * @param {Date} startedAt
 * @param {number} maxRunMs
 * @returns {boolean}
 */
export function isRunBudgetExceeded(startedAt, maxRunMs) {
  if (!maxRunMs) {
    return false;
  }
  return Date.now() - startedAt.getTime() >= maxRunMs;
}

/**
 * Execute native tool calls from a model message.
 * @param {object} message
 * @param {object} tools
 * @param {Array} messages
 * @param {boolean} quiet
 * @returns {Promise<number>} Number of executed calls
 */
export async function executeNativeToolCalls(message, tools, messages, quiet) {
  if (!message.tool_calls || message.tool_calls.length === 0) {
    return 0;
  }

  let executed = 0;
  for (const tc of message.tool_calls) {
    const args = parseToolArguments(tc.function.arguments);
    const result = await dispatchTool(
      { name: tc.function.name, args },
      tools,
      quiet,
    );

    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(result),
    });
    executed++;
  }

  return executed;
}

/**
 * Execute a recovered text-form tool call if the message contains exactly one.
 * @param {object} message
 * @param {object} tools
 * @param {Array} messages
 * @param {boolean} quiet
 * @returns {Promise<boolean>}
 */
export async function executeRecoveredTextToolCall(
  message,
  tools,
  messages,
  quiet,
) {
  if (message.tool_calls && message.tool_calls.length > 0) {
    return false;
  }
  const call = recoverTextToolCall(message.content || '');
  if (!call) {
    return false;
  }

  const result = await dispatchTool(call, tools, quiet);
  messages.push({
    role: 'user',
    content: `Recovered text-form tool call ${call.name}. Result:\n${JSON.stringify(result)}`,
  });
  return true;
}

/**
 * Recover a single text-form tool call in the exact shape:
 * `tool_name[ARGS]{...}`.
 * @param {string} content
 * @returns {{ name: string, args: object } | null}
 */
export function recoverTextToolCall(content) {
  const match = content.trim().match(/^([a-z][a-z0-9_]*)\[ARGS\]([\s\S]+)$/);
  if (!match) {
    return null;
  }

  const args = parseToolArguments(match[2]);
  if (!isPlainObject(args)) {
    return null;
  }
  return { name: match[1], args };
}

function parseToolArguments(value) {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function dispatchTool(call, tools, quiet) {
  if (!quiet) {
    process.stderr.write(`${formatToolCall(call.name, call.args)}\n`);
  }

  const result = await tools.dispatch(call.name, call.args);

  if (!quiet) {
    process.stderr.write(`${formatToolResult(call.name, result)}\n`);
  }

  return result;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return !Array.isArray(value);
}
