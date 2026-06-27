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
 * @returns {Promise<{ healed: boolean, turns: number, verification: object, usage: { prompt: number, completion: number } }>}
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
  } = params;

  let lastOutput = failure.output;
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
    });
    totalUsage.prompt += loop.usage.prompt;
    totalUsage.completion += loop.usage.completion;

    // Re-verify
    const result = await verifyFn();
    if (result.passed) {
      return {
        healed: true,
        turns: turn,
        verification: result,
        usage: totalUsage,
      };
    }

    // Stop early if the run budget was spent mid-repair.
    if (loop.stoppedReason === 'budget-exceeded') {
      return {
        healed: false,
        turns: turn,
        verification: result,
        usage: totalUsage,
      };
    }

    // No-progress check: same output means the fix didn't help
    if (hasNoProgress(lastOutput, result.output)) {
      return {
        healed: false,
        turns: turn,
        verification: result,
        usage: totalUsage,
      };
    }

    lastOutput = result.output;
  }

  // Exhausted turns
  const finalResult = await verifyFn();
  return {
    healed: finalResult.passed,
    turns: maxTurns,
    verification: finalResult,
    usage: totalUsage,
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
