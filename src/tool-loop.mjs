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

import {
  COMPACTION_THRESHOLD,
  compactMessages,
  needsCompaction,
} from './compact.mjs';
import { formatNotice, formatToolCall, formatToolResult } from './format.mjs';
import { runPostToolHooks, runPreToolHooks } from './hooks.mjs';
import {
  isUnparseableArgs,
  recoverToolCalls,
  recoverToolName,
} from './tool-recovery.mjs';

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
 * @param {number} [params.maxToolTurns] - Tool-turn ceiling (default MAX_TOOL_TURNS)
 * @param {number} [params.contextWindow] - Max context window in tokens (0 disables compaction)
 * @param {number} [params.compactThreshold] - Fraction of the window that triggers compaction
 * @param {{ PreToolUse: Array, PostToolUse: Array }} [params.toolHooks] - Tool hooks
 * @param {string} [params.cwd] - Workspace root (for tool hooks)
 * @param {Record<string, string>} [params.commandEnv] - Curated env (for tool hooks)
 * @param {number} [params.heartbeatMs] - Interval for "still waiting on a
 *   model response" notices while a chat request is in flight (0 disables) --
 *   a large prompt can spend minutes in prefill before the first token
 *   streams, which is otherwise silent
 * @param {function} [params.onHeartbeat] - Called with elapsed ms on each heartbeat tick
 * @param {function} [params.onDebug] - Called once per HTTP attempt with the raw
 *   request/response (see specs/debug-log.yaml); forwarded to every chat call
 * @returns {Promise<{ finalText: string, completed: boolean, stoppedReason: string, toolTurns: number, compactions: number, usage: { prompt: number, completion: number }, retries: number }>}
 */
export async function runToolLoop(params) {
  const { client, modelId, messages, tools, quiet = false } = params;
  const { startedAt, maxRunMs = 0, maxToolTurns = MAX_TOOL_TURNS } = params;
  const { contextWindow = 0, compactThreshold = COMPACTION_THRESHOLD } = params;
  const { heartbeatMs = 0, onHeartbeat, onDebug } = params;
  const hookCtx = buildHookCtx(params);

  const usage = { prompt: 0, completion: 0, cost: 0 };
  let toolTurns = 0;
  let compactions = 0;
  let retries = 0;
  let finalText = '';
  let completed = false;
  let stoppedReason = 'tool-limit';

  try {
    await runLoopBody();
  } catch (err) {
    // Preserve the accounting done before the failure. runToolLoop returns
    // usage/turns only on the normal path, so an unhandled throw would
    // otherwise reach the harness catch and be recorded as toolTurns: 0,
    // cost: 0 -- silently corrupting the exact metrics the harness exists
    // to produce. Attach what we accumulated (mirroring how err.retries is
    // already carried) so createErrorResult can report the real numbers.
    err.usage = usage;
    err.toolTurns = toolTurns;
    err.compactions = compactions;
    err.retries = retries + (err.retries || 0);
    throw err;
  }

  return {
    finalText,
    completed,
    stoppedReason,
    toolTurns,
    compactions,
    usage,
    retries,
  };

  async function runLoopBody() {
    while (toolTurns < maxToolTurns) {
      if (isRunBudgetExceeded(startedAt, maxRunMs)) {
        stoppedReason = 'budget-exceeded';
        break;
      }

      const {
        message,
        usage: turnUsage,
        retries: turnRetries,
      } = await client.chat({
        model: modelId,
        messages,
        tools: tools.definitions(),
        onToken: quiet ? undefined : (t) => process.stdout.write(t),
        timeoutMs: remainingRunBudgetMs(startedAt, maxRunMs),
        heartbeatMs,
        onHeartbeat,
        onDebug,
      });

      usage.prompt += turnUsage.prompt;
      usage.completion += turnUsage.completion;
      usage.cost += turnUsage.cost || 0;
      retries += turnRetries || 0;
      const lastPromptTokens = turnUsage.prompt;
      messages.push(message);

      const nativeCalls = await executeNativeToolCalls(
        message,
        tools,
        messages,
        quiet,
        hookCtx,
      );
      if (nativeCalls === 0) {
        const recovered = await executeRecoveredTextToolCall(
          message,
          tools,
          messages,
          quiet,
          hookCtx,
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

      const compacted = await maybeCompact({
        client,
        modelId,
        messages,
        lastPromptTokens,
        contextWindow,
        compactThreshold,
        quiet,
        usage,
        timeoutMs: remainingRunBudgetMs(startedAt, maxRunMs),
        heartbeatMs,
        onHeartbeat,
        onDebug,
      });
      if (compacted.compacted) {
        compactions++;
      }
      retries += compacted.retries || 0;
    }
  }
}

/**
 * Compact the conversation in place when the live context has crossed the
 * threshold. Best effort: a failed summary leaves the conversation untouched
 * and the loop continues.
 * @param {object} params
 * @returns {Promise<{ compacted: boolean, retries: number }>} Whether the
 *   conversation was compacted, and retries the summary chat call used
 */
async function maybeCompact(params) {
  const { client, modelId, messages, lastPromptTokens, usage, quiet } = params;
  const { contextWindow, compactThreshold, timeoutMs } = params;
  const { heartbeatMs, onHeartbeat, onDebug } = params;

  if (!needsCompaction(lastPromptTokens, contextWindow, compactThreshold)) {
    return { compacted: false, retries: 0 };
  }

  if (!quiet) {
    const limit = Math.round(contextWindow * compactThreshold);
    process.stderr.write(
      `${formatNotice(`compacting context (${lastPromptTokens} >= ${limit} tokens)`)}\n`,
    );
  }

  const result = await compactMessages({
    client,
    modelId,
    messages,
    quiet,
    timeoutMs,
    heartbeatMs,
    onHeartbeat,
    onDebug,
  });
  usage.prompt += result.usage.prompt;
  usage.completion += result.usage.completion;
  usage.cost += result.usage.cost || 0;
  const retries = result.retries || 0;

  if (result.error) {
    if (!quiet) {
      process.stderr.write(
        `${formatNotice(`compaction skipped: ${result.error}`)}\n`,
      );
    }
    return { compacted: false, retries };
  }

  messages.splice(0, messages.length, ...result.messages);
  return { compacted: true, retries };
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
 * Time left in the run's wall-clock budget, for capping a single request
 * (e.g. an LLM completion) so it can't outlive the run deadline. Returns
 * undefined when no run budget is set.
 * @param {Date} startedAt
 * @param {number} maxRunMs
 * @returns {number | undefined}
 */
export function remainingRunBudgetMs(startedAt, maxRunMs) {
  if (!maxRunMs) {
    return undefined;
  }
  const remaining = maxRunMs - (Date.now() - startedAt.getTime());
  return Math.max(1, remaining);
}

/**
 * Execute native tool calls from a model message.
 * @param {object} message
 * @param {object} tools
 * @param {Array} messages
 * @param {boolean} quiet
 * @returns {Promise<number>} Number of executed calls
 */
export async function executeNativeToolCalls(
  message,
  tools,
  messages,
  quiet,
  hookCtx,
) {
  if (!message.tool_calls || message.tool_calls.length === 0) {
    return 0;
  }

  let executed = 0;
  for (const tc of message.tool_calls) {
    const result = await executeOneNativeCall(tc, tools, quiet, hookCtx);
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
 * Execute one native tool call. Untrusted output: a model can emit unparseable
 * arguments (mis-escaped or truncated). Storing that raw and replaying it can
 * break the backend chat template (a deterministic 500 that aborts the run), so
 * repair the stored arguments in place to "{}" and return a clear error telling
 * the model to resend a valid call, rather than dispatching garbage.
 * @returns {Promise<object>} The tool result (or a repair error)
 */
async function executeOneNativeCall(tc, tools, quiet, hookCtx) {
  if (isUnparseableArgs(tc.function.arguments)) {
    tc.function.arguments = '{}';
    if (!quiet) {
      process.stderr.write(
        `${formatNotice(`repaired malformed arguments for tool call ${recoverToolName(tc.function.name)}`)}\n`,
      );
    }
    return {
      error:
        'tool-call arguments were not valid JSON; resend the call with the arguments as a single valid JSON object',
    };
  }

  const name = recoverToolName(tc.function.name);
  const args = parseToolArguments(tc.function.arguments);
  return dispatchTool({ name, args }, tools, quiet, hookCtx);
}

/**
 * Execute any text-form tool calls recovered from the message (a compatibility
 * fallback when the model emits calls as text). Runs every recovered call and
 * feeds each result back. Returns true if at least one ran.
 * @param {object} message
 * @param {object} tools
 * @param {Array} messages
 * @param {boolean} quiet
 * @param {object} [hookCtx]
 * @returns {Promise<boolean>}
 */
export async function executeRecoveredTextToolCall(
  message,
  tools,
  messages,
  quiet,
  hookCtx,
) {
  if (message.tool_calls && message.tool_calls.length > 0) {
    return false;
  }
  const calls = recoverToolCalls(message.content || '');
  if (calls.length === 0) {
    return false;
  }

  for (const call of calls) {
    const result = await dispatchTool(call, tools, quiet, hookCtx);
    messages.push({
      role: 'user',
      content: `Recovered text-form tool call ${call.name}. Result:\n${JSON.stringify(result)}`,
    });
  }
  return true;
}

// Re-exported so existing callers and tests keep importing it from here.
export { recoverTextToolCall } from './tool-recovery.mjs';

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

async function dispatchTool(call, tools, quiet, hookCtx) {
  if (!quiet) {
    process.stderr.write(`${formatToolCall(call.name, call.args)}\n`);
  }

  const denial = await denyByPreToolHooks(call, hookCtx);
  if (denial) {
    if (!quiet) {
      process.stderr.write(`${formatToolResult(call.name, denial)}\n`);
    }
    return denial;
  }

  const result = await tools.dispatch(call.name, call.args);
  const finalResult = await applyPostToolHooks(call, result, hookCtx);

  if (!quiet) {
    process.stderr.write(`${formatToolResult(call.name, finalResult)}\n`);
  }

  return finalResult;
}

/**
 * Assemble the tool-hook context from loop params, or null when no tool hooks
 * are configured (keeping dispatch a no-op fast path).
 */
function buildHookCtx(params) {
  const sets = params.toolHooks;
  if (!sets) {
    return null;
  }
  return {
    pre: sets.PreToolUse || [],
    post: sets.PostToolUse || [],
    cwd: params.cwd,
    env: params.commandEnv,
    startedAt: params.startedAt,
    maxRunMs: params.maxRunMs || 0,
  };
}

/**
 * Run PreToolUse hooks; return an error result when the call is denied, else
 * null to let the tool run.
 */
async function denyByPreToolHooks(call, hookCtx) {
  if (!hookCtx || hookCtx.pre.length === 0) {
    return null;
  }
  const { denied, reason } = await runPreToolHooks(
    hookCtx.pre,
    call,
    hookCtx.cwd,
    {
      env: hookCtx.env,
      budgetMs: remainingHookBudgetMs(hookCtx),
    },
  );
  if (denied) {
    return { error: reason };
  }
  return null;
}

/**
 * Run PostToolUse hooks; attach their feedback to the result when any failed.
 */
async function applyPostToolHooks(call, result, hookCtx) {
  if (!hookCtx || hookCtx.post.length === 0) {
    return result;
  }
  const { feedback } = await runPostToolHooks(
    hookCtx.post,
    call,
    result,
    hookCtx.cwd,
    { env: hookCtx.env, budgetMs: remainingHookBudgetMs(hookCtx) },
  );
  if (!feedback) {
    return result;
  }
  return withHookFeedback(result, feedback);
}

function withHookFeedback(result, feedback) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, hookFeedback: feedback };
  }
  return { result, hookFeedback: feedback };
}

function remainingHookBudgetMs(hookCtx) {
  if (!hookCtx.startedAt || !hookCtx.maxRunMs) {
    return undefined;
  }
  const remaining =
    hookCtx.maxRunMs - (Date.now() - hookCtx.startedAt.getTime());
  return Math.max(1, remaining);
}
