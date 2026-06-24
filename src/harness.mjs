/**
 * The harness — orchestrates the full run loop.
 * context → model + tools → verify → heal
 */

import { buildSystemPrompt } from './context.mjs';
import { createClient } from './model.mjs';
import { createToolRegistry } from './tools/index.mjs';
import { verify } from './verify.mjs';
import { heal } from './heal.mjs';
import { formatToolCall, formatToolResult, formatResponse, formatVerification, formatSummary } from './format.mjs';

const MAX_TOOL_TURNS = 20;

/**
 * Run the harness.
 * @param {string} prompt - User prompt
 * @param {object} options
 * @param {string} options.cwd - Workspace root (absolute path)
 * @param {string} [options.baseUrl] - LM Studio base URL
 * @param {string} [options.model] - Model identifier
 * @param {string} [options.testCommand] - Verification command
 * @param {number} [options.maxHealTurns] - Max heal turns (default 3)
 * @param {boolean} [options.quiet] - Suppress terminal output
 * @param {Array} [options.priorMessages] - Continuation from previous run
 * @returns {Promise<object>} Run result
 */
export async function run(prompt, options) {
  const { cwd, testCommand, maxHealTurns = 3, quiet = false, priorMessages } = options;

  const client = createClient({
    baseUrl: options.baseUrl,
    model: options.model,
  });

  const modelId = await client.resolveModel();
  const tools = createToolRegistry(cwd);
  const systemPrompt = await buildSystemPrompt(cwd);

  // Build messages
  const messages = [];
  messages.push({ role: 'system', content: systemPrompt });

  if (priorMessages) {
    // Continuation: include prior conversation (skip system message)
    for (const msg of priorMessages) {
      if (msg.role !== 'system') {
        messages.push(msg);
      }
    }
  }

  messages.push({ role: 'user', content: prompt });

  // Run tool loop
  let totalUsage = { prompt: 0, completion: 0 };
  let toolTurns = 0;
  let finalText = '';

  while (toolTurns < MAX_TOOL_TURNS) {
    const { message, usage } = await client.chat({
      model: modelId,
      messages,
      tools: tools.definitions(),
      onToken: quiet ? undefined : (t) => process.stdout.write(t),
    });

    totalUsage.prompt += usage.prompt;
    totalUsage.completion += usage.completion;

    messages.push(message);

    // No tool calls = final response
    if (!message.tool_calls || message.tool_calls.length === 0) {
      finalText = message.content || '';
      if (!quiet) process.stdout.write('\n');
      break;
    }

    // Execute tool calls
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

    toolTurns++;
  }

  // Build result
  const result = {
    response: finalText,
    filesChanged: tools.filesChanged(),
    toolTurns,
    usage: totalUsage,
    messages,
  };

  // Verify if test command is set
  if (testCommand && tools.filesChanged().length > 0) {
    const verifyResult = await verify(testCommand, cwd);
    result.verification = verifyResult;

    if (!quiet) process.stderr.write(formatVerification(verifyResult) + '\n');

    // Heal if verification failed
    if (!verifyResult.passed) {
      const healResult = await heal({
        client,
        modelId,
        messages,
        tools,
        verifyFn: () => verify(testCommand, cwd),
        failure: verifyResult,
        maxTurns: maxHealTurns,
        quiet,
      });

      result.healed = healResult.healed;
      result.healTurns = healResult.turns;
      result.verification = healResult.verification;
      totalUsage.prompt += healResult.usage.prompt;
      totalUsage.completion += healResult.usage.completion;
    }
  }

  // Save run transcript
  await saveRun(cwd, result);

  if (!quiet) process.stderr.write(formatSummary(result) + '\n');

  return result;
}

async function saveRun(cwd, result) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const runDir = join(cwd, '.kodr', 'runs');
  await mkdir(runDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(runDir, `${timestamp}.json`);

  const data = {
    timestamp: new Date().toISOString(),
    filesChanged: result.filesChanged,
    toolTurns: result.toolTurns,
    usage: result.usage,
    verified: result.verification?.passed ?? null,
    healed: result.healed ?? null,
    messages: result.messages,
  };

  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}
