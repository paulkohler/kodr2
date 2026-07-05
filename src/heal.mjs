/**
 * Healing loop — bounded repair when verification fails.
 * Feeds failure output back to the model, lets it use tools to fix,
 * re-verifies. Stops on: pass, turn limit, or no-progress.
 */

import { formatHealTurn } from './format.mjs';
import { runToolLoop } from './tool-loop.mjs';

const DEFAULT_MAX_TURNS = 3;

/**
 * Run the healing loop.
 * @param {object} params
 * @param {object} params.client - Model client
 * @param {string} params.modelId - Model to use
 * @param {Array} params.messages - Conversation so far
 * @param {object} params.tools - Tool registry
 * @param {function} params.verifyFn - Verification function () => result
 * @param {{ passed: boolean, output: string }} params.failure - Initial failure
 * @param {number} [params.maxTurns] - Max repair turns
 * @param {boolean} [params.quiet] - Suppress terminal output
 * @param {Date} [params.startedAt] - Run start, for the budget check
 * @param {number} [params.maxRunMs] - Stop between turns after this many ms (0 disables)
 * @param {number} [params.maxToolTurns] - Tool-turn ceiling per heal turn (default MAX_TOOL_TURNS)
 * @param {number} [params.contextWindow] - Max context window in tokens (0 disables compaction)
 * @param {number} [params.compactThreshold] - Fraction of the window that triggers compaction
 * @param {{ PreToolUse: Array, PostToolUse: Array }} [params.toolHooks] - Tool hooks for the loop
 * @param {string} [params.cwd] - Workspace root (for tool hooks)
 * @param {Record<string, string>} [params.commandEnv] - Curated env (for tool hooks)
 * @param {number} [params.heartbeatMs] - Interval for "still waiting on a model response" notices (0 disables)
 * @param {function} [params.onHeartbeat] - Called with elapsed ms on each heartbeat tick
 * @param {function} [params.onDebug] - Forwarded to the tool loop (see specs/debug-log.yaml)
 * @returns {Promise<{ healed: boolean, turns: number, verification: object, compactions: number, usage: { prompt: number, completion: number }, retries: number }>}
 */
export async function heal(params) {
  const {
    client,
    modelId,
    messages,
    tools,
    verifyFn,
    failure,
    maxTurns = DEFAULT_MAX_TURNS,
    quiet = false,
    startedAt,
    maxRunMs = 0,
    maxToolTurns,
    contextWindow = 0,
    compactThreshold,
    toolHooks,
    cwd,
    commandEnv,
    heartbeatMs,
    onHeartbeat,
    onDebug,
  } = params;

  let lastOutput = failure.output;
  let lastResult = null;
  let compactions = 0;
  let totalRetries = 0;
  const totalUsage = { prompt: 0, completion: 0 };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (!quiet) {
      process.stderr.write(`${formatHealTurn(turn, maxTurns)}\n`);
    }

    // Add failure context
    messages.push({
      role: 'user',
      content: `Verification failed. Fix the issues and try again.

Use the provided tool channel for every tool call. Do not write tool calls as text, Markdown, XML, JSON blocks, or formats like tool_name[ARGS]{...}.

<failure>
${lastOutput}
</failure>`,
    });

    // Let the model use tools to fix, on the same loop the main run uses.
    // The loop's finalText/completed are irrelevant here — we judge progress
    // by re-verifying — but its usage and stop reason are not.
    const loop = await runToolLoop({
      client,
      modelId,
      messages,
      tools,
      quiet,
      startedAt,
      maxRunMs,
      maxToolTurns,
      contextWindow,
      compactThreshold,
      toolHooks,
      cwd,
      commandEnv,
      heartbeatMs,
      onHeartbeat,
      onDebug,
    });
    totalUsage.prompt += loop.usage.prompt;
    totalUsage.completion += loop.usage.completion;
    compactions += loop.compactions || 0;
    totalRetries += loop.retries || 0;

    // Re-verify
    const result = await verifyFn();
    lastResult = result;
    if (result.passed) {
      return {
        healed: true,
        turns: turn,
        verification: result,
        compactions,
        usage: totalUsage,
        retries: totalRetries,
      };
    }

    // Stop early if the run budget was spent mid-repair.
    if (loop.stoppedReason === 'budget-exceeded') {
      return {
        healed: false,
        turns: turn,
        verification: result,
        compactions,
        usage: totalUsage,
        retries: totalRetries,
      };
    }

    // No-progress check: same output means the fix didn't help
    if (hasNoProgress(lastOutput, result.output)) {
      return {
        healed: false,
        turns: turn,
        verification: result,
        compactions,
        usage: totalUsage,
        retries: totalRetries,
      };
    }

    lastOutput = result.output;
  }

  // Exhausted turns: report the last verification the loop already observed,
  // rather than running verifyFn() a second, unbudgeted time. Re-verifying here
  // both doubles the cost of the final check (a full test suite) and, on a
  // flaky or timing-sensitive suite, could report a pass the state produced by
  // the last heal turn never actually achieved -- corrupting the healed/verified
  // signal that `kodr stats` aggregates. lastResult is only null when maxTurns
  // is 0 (no repair turn ran), where a single verify is the intended behavior.
  const finalResult = lastResult ?? (await verifyFn());
  return {
    healed: finalResult.passed,
    turns: maxTurns,
    verification: finalResult,
    compactions,
    usage: totalUsage,
    retries: totalRetries,
  };
}

export function hasNoProgress(previousOutput, currentOutput) {
  return normalizeOutput(currentOutput) === normalizeOutput(previousOutput);
}

/**
 * Normalize verification output so that runs which differ only in timing
 * (durations, timestamps) compare equal. Line numbers, counts, and test
 * names are preserved so genuinely different failures still register progress.
 */
function normalizeOutput(output) {
  return (output || '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?/g, '<ts>')
    .replace(/duration_ms:\s*[\d.]+/g, 'duration_ms: <dur>')
    .replace(/\d+(\.\d+)?\s?ms\b/g, '<dur>')
    .replace(/\d+(\.\d+)?\s?s\b/g, '<dur>')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
