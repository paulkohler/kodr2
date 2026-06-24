/**
 * Healing loop — bounded repair when verification fails.
 * Feeds failure output back to the model, lets it use tools to fix,
 * re-verifies. Stops on: pass, turn limit, or no-progress.
 */

import { formatHealTurn, formatToolCall, formatToolResult } from './format.mjs';

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
  let totalUsage = { prompt: 0, completion: 0 };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (!quiet) process.stderr.write(formatHealTurn(turn, maxTurns) + '\n');

    // Add failure context
    messages.push({
      role: 'user',
      content: `Verification failed. Fix the issues and try again.\n\n<failure>\n${lastOutput}\n</failure>`,
    });

    // Let model use tools to fix
    const turnResult = await runToolLoop(client, modelId, messages, tools, quiet);
    totalUsage.prompt += turnResult.usage.prompt;
    totalUsage.completion += turnResult.usage.completion;

    // Re-verify
    const result = await verifyFn();
    if (result.passed) {
      return { healed: true, turns: turn, verification: result, usage: totalUsage };
    }

    // No-progress check: same output means the fix didn't help
    if (result.output === lastOutput) {
      return { healed: false, turns: turn, verification: result, usage: totalUsage };
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

async function runToolLoop(client, modelId, messages, tools, quiet) {
  let totalUsage = { prompt: 0, completion: 0 };

  while (true) {
    const { message, usage } = await client.chat({
      model: modelId,
      messages,
      tools: tools.definitions(),
    });

    totalUsage.prompt += usage.prompt;
    totalUsage.completion += usage.completion;

    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    for (const tc of message.tool_calls) {
      let args;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      if (!quiet) process.stderr.write(formatToolCall(tc.function.name, args) + '\n');

      const result = await tools.dispatch(tc.function.name, args);

      if (!quiet) process.stderr.write(formatToolResult(tc.function.name, result) + '\n');

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { usage: totalUsage };
}
