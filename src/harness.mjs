/**
 * The harness — orchestrates the full run loop.
 * context → model + tools → verify → heal
 */

import { buildSystemPrompt } from './context.mjs';
import { createClient } from './model.mjs';
import { createToolRegistry } from './tools/index.mjs';
import { buildEnv } from './env.mjs';
import { verify } from './verify.mjs';
import { heal } from './heal.mjs';
import {
  MAX_TOOL_TURNS,
  isRunBudgetExceeded,
  runToolLoop,
} from './tool-loop.mjs';
import { formatNotice, formatVerification, formatSummary } from './format.mjs';

// Re-exported for callers (and tests) that imported it from the harness.
export { isRunBudgetExceeded };

/**
 * Run the harness.
 * @param {string} prompt - User prompt
 * @param {object} options
 * @param {string} options.cwd - Workspace root (absolute path)
 * @param {string} [options.baseUrl] - LM Studio base URL
 * @param {string} [options.model] - Model identifier
 * @param {string} [options.testCommand] - Verification command
 * @param {number} [options.maxHealTurns] - Max heal turns (default 3)
 * @param {number} [options.maxRunMs] - Stop between turns after this many ms (0 disables)
 * @param {boolean} [options.quiet] - Suppress terminal output
 * @param {Array} [options.priorMessages] - Continuation from previous run
 * @param {string[]} [options.envPassthrough] - Extra env var names for commands
 * @returns {Promise<object>} Run result
 */
export async function run(prompt, options) {
  const startedAt = new Date();
  const {
    cwd,
    testCommand,
    maxHealTurns = 3,
    maxRunMs = 0,
    quiet = false,
    priorMessages,
    envPassthrough = [],
  } = options;

  const client = createClient({
    baseUrl: options.baseUrl,
    model: options.model,
  });

  const modelId = await client.resolveModel();
  const metadata = {
    cwd,
    prompt,
    baseUrl: options.baseUrl || 'http://localhost:1234/v1',
    model: modelId,
    testCommand: testCommand || null,
    maxHealTurns,
    maxRunMs,
    envPassthrough,
    startedAt: startedAt.toISOString(),
  };
  const tools = createToolRegistry(cwd, { envPassthrough });
  const commandEnv = buildEnv(envPassthrough);
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

  // Run the tool loop
  const loop = await runToolLoop({
    client,
    modelId,
    messages,
    tools,
    quiet,
    startedAt,
    maxRunMs,
  });
  const totalUsage = loop.usage;
  const { completed, stoppedReason, toolTurns } = loop;

  // The model never produced a final response — it ran out of turns or budget.
  if (!completed && !quiet) {
    process.stderr.write(`${formatNotice(formatStopReason(stoppedReason))}\n`);
  }

  // Build result
  const result = {
    metadata,
    response: loop.finalText,
    filesChanged: tools.filesChanged(),
    toolTurns,
    stoppedReason,
    usage: totalUsage,
    messages,
  };

  // Verify if a test command is set and the model touched the workspace
  // (writes, or shell commands that may have changed files).
  const touchedWorkspace =
    tools.filesChanged().length > 0 || tools.commandsRun() > 0;
  if (testCommand && touchedWorkspace && stoppedReason === 'complete') {
    const verifyResult = await verify(testCommand, cwd, { env: commandEnv });
    result.verification = verifyResult;

    if (!quiet) {
      process.stderr.write(`${formatVerification(verifyResult)}\n`);
    }

    // Heal if verification failed
    if (!verifyResult.passed && !isRunBudgetExceeded(startedAt, maxRunMs)) {
      const healResult = await heal({
        client,
        modelId,
        messages,
        tools,
        verifyFn: () => verify(testCommand, cwd, { env: commandEnv }),
        failure: verifyResult,
        maxTurns: maxHealTurns,
        quiet,
        startedAt,
        maxRunMs,
      });

      result.healed = healResult.healed;
      result.healTurns = healResult.turns;
      result.verification = healResult.verification;
      totalUsage.prompt += healResult.usage.prompt;
      totalUsage.completion += healResult.usage.completion;
    }
  }

  // Save run transcript
  await saveRun(cwd, result, startedAt);

  if (!quiet) {
    process.stderr.write(`${formatSummary(result)}\n`);
  }

  return result;
}

function formatStopReason(stoppedReason) {
  if (stoppedReason === 'budget-exceeded') {
    return 'stopped after run budget';
  }
  return `stopped after ${MAX_TOOL_TURNS} tool turns`;
}

async function saveRun(cwd, result, startedAt) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const runDir = join(cwd, '.kodr', 'runs');
  await mkdir(runDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(runDir, `${timestamp}.json`);

  const finishedAt = new Date();
  const data = createRunRecord(result, {
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });

  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export function createRunRecord(result, finish = {}) {
  return {
    timestamp: finish.finishedAt || new Date().toISOString(),
    metadata: result.metadata || {},
    durationMs: finish.durationMs ?? null,
    filesChanged: result.filesChanged,
    toolTurns: result.toolTurns,
    stoppedReason: result.stoppedReason,
    usage: result.usage,
    verified: result.verification?.passed ?? null,
    healed: result.healed ?? null,
    healTurns: result.healTurns ?? null,
    messages: result.messages,
  };
}
