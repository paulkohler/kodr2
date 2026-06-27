/**
 * Healing loop — bounded repair when verification fails.
 * Feeds failure output back to the model, lets it use tools to fix,
 * re-verifies. Stops on: pass, turn limit, or no-progress.
 */

import { formatHealTurn } from './format.mjs';
import {
  executeNativeToolCalls,
  executeRecoveredTextToolCall,
} from './tool-loop.mjs';

const DEFAULT_MAX_TURNS = 3;
const MAX_TOOL_TURNS = 20;

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

    // Let model use tools to fix
    const turnResult = await runToolLoop(
      client,
      modelId,
      messages,
      tools,
      quiet,
    );
    totalUsage.prompt += turnResult.usage.prompt;
    totalUsage.completion += turnResult.usage.completion;

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

async function runToolLoop(client, modelId, messages, tools, quiet) {
  const totalUsage = { prompt: 0, completion: 0 };

  let toolTurns = 0;
  while (toolTurns < MAX_TOOL_TURNS) {
    const { message, usage } = await client.chat({
      model: modelId,
      messages,
      tools: tools.definitions(),
    });

    totalUsage.prompt += usage.prompt;
    totalUsage.completion += usage.completion;

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
        break;
      }
    }

    toolTurns++;
  }

  return { usage: totalUsage };
}
