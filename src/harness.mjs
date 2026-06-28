/**
 * The harness — orchestrates the full run loop.
 * context → model + tools → verify → heal
 */

import { buildSystemPrompt } from './context.mjs';
import { createClient, hasContextHeadroom } from './model.mjs';
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
import {
  DEFAULT_CONTEXT_WINDOW,
  compactMessages,
  configuredContextWindow,
  isCompactCommand,
} from './compact.mjs';

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
 * @param {number} [options.contextWindow] - Max context window in tokens (0 disables compaction)
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
    timeout: maxRunMs || undefined,
  });

  const modelId = await client.resolveModel();
  const contextWindow = await resolveContextWindow({
    option: options.contextWindow,
    client,
    modelId,
    quiet,
  });
  const metadata = {
    cwd,
    prompt,
    baseUrl: options.baseUrl || 'http://localhost:1234/v1',
    model: modelId,
    testCommand: testCommand || null,
    maxHealTurns,
    maxRunMs,
    envPassthrough,
    contextWindow,
    startedAt: startedAt.toISOString(),
  };
  const tools = createToolRegistry(cwd, {
    envPassthrough,
    startedAt,
    maxRunMs,
  });
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

  // On-demand compaction: "/compact" compresses the prior conversation
  // instead of running a new task.
  if (isCompactCommand(prompt)) {
    return await runManualCompaction({
      client,
      modelId,
      cwd,
      messages,
      metadata,
      quiet,
      startedAt,
    });
  }

  messages.push({ role: 'user', content: prompt });

  let result;
  try {
    // Run the tool loop
    const loop = await runToolLoop({
      client,
      modelId,
      messages,
      tools,
      quiet,
      startedAt,
      maxRunMs,
      contextWindow,
    });
    const totalUsage = loop.usage;
    const { completed, stoppedReason, toolTurns } = loop;
    let compactions = loop.compactions;

    // The model never produced a final response — it ran out of turns or budget.
    if (!completed && !quiet) {
      process.stderr.write(
        `${formatNotice(formatStopReason(stoppedReason))}\n`,
      );
    }

    // Build result
    result = {
      metadata,
      response: loop.finalText,
      filesChanged: tools.filesChanged(),
      packageCommands: tools.packageCommands(),
      toolTurns,
      stoppedReason,
      usage: totalUsage,
      compactions,
      messages,
    };

    // Verify if a test command is set and the model touched the workspace
    // (writes, or shell commands that may have changed files).
    const touchedWorkspace =
      tools.filesChanged().length > 0 || tools.commandsRun() > 0;
    if (testCommand && touchedWorkspace && stoppedReason === 'complete') {
      const verifyResult = await verify(testCommand, cwd, {
        env: commandEnv,
        timeout: remainingRunBudgetMs(startedAt, maxRunMs),
      });
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
          verifyFn: () =>
            verify(testCommand, cwd, {
              env: commandEnv,
              timeout: remainingRunBudgetMs(startedAt, maxRunMs),
            }),
          failure: verifyResult,
          maxTurns: maxHealTurns,
          quiet,
          startedAt,
          maxRunMs,
          contextWindow,
        });

        result.healed = healResult.healed;
        result.healTurns = healResult.turns;
        result.verification = healResult.verification;
        compactions += healResult.compactions || 0;
        result.compactions = compactions;
        result.packageCommands = tools.packageCommands();
        totalUsage.prompt += healResult.usage.prompt;
        totalUsage.completion += healResult.usage.completion;
      }
    }
  } catch (err) {
    result = createErrorResult({
      metadata,
      err,
      messages,
      tools,
    });
    if (!quiet) {
      process.stderr.write(`${formatNotice(`run failed: ${err.message}`)}\n`);
    }
  }

  // Save run transcript
  await saveRun(cwd, result, startedAt);

  if (!quiet) {
    process.stderr.write(`${formatSummary(result)}\n`);
  }

  return result;
}

function createErrorResult(params) {
  const { metadata, err, messages, tools } = params;
  return {
    metadata,
    response: '',
    error: {
      message: err.message,
      name: err.name,
      stack: err.stack,
    },
    filesChanged: tools.filesChanged(),
    packageCommands: tools.packageCommands(),
    toolTurns: 0,
    stoppedReason: 'error',
    usage: { prompt: 0, completion: 0 },
    compactions: 0,
    messages,
  };
}

export function remainingRunBudgetMs(startedAt, maxRunMs) {
  if (!maxRunMs) {
    return undefined;
  }
  const remaining = maxRunMs - (Date.now() - startedAt.getTime());
  return Math.max(1, remaining);
}

/**
 * On-demand compaction. Compresses the prior conversation in `messages` and
 * saves the result as a run, rather than running a new task.
 * @param {object} params
 * @returns {Promise<object>} Run result
 */
async function runManualCompaction(params) {
  const { client, modelId, cwd, messages, metadata, quiet, startedAt } = params;

  // messages holds the fresh system prompt plus any continued conversation.
  const hasHistory = messages.some((message) => message.role !== 'system');
  if (!hasHistory) {
    const result = emptyCompactionResult(
      metadata,
      messages,
      'Nothing to compact — no prior conversation. Use --continue to load one.',
    );
    await saveRun(cwd, result, startedAt);
    if (!quiet) {
      process.stderr.write(`${formatNotice(result.response)}\n`);
    }
    return result;
  }

  const compactResult = await compactMessages({
    client,
    modelId,
    messages,
    quiet,
  });

  if (!compactResult.error) {
    messages.splice(0, messages.length, ...compactResult.messages);
  }

  const result = {
    metadata,
    response: compactResult.error
      ? `Compaction failed: ${compactResult.error}`
      : compactResult.summary,
    filesChanged: [],
    toolTurns: 0,
    stoppedReason: 'complete',
    usage: compactResult.usage,
    compactions: compactResult.error ? 0 : 1,
    messages,
  };

  await saveRun(cwd, result, startedAt);
  if (!quiet) {
    process.stderr.write(`${formatSummary(result)}\n`);
  }
  return result;
}

function emptyCompactionResult(metadata, messages, response) {
  return {
    metadata,
    response,
    filesChanged: [],
    toolTurns: 0,
    stoppedReason: 'complete',
    usage: { prompt: 0, completion: 0 },
    compactions: 0,
    messages,
  };
}

/**
 * Resolve the context window for a run. Precedence: an explicit option or the
 * KODR_CONTEXT_WINDOW env var, then the model's loaded context length probed
 * from LM Studio, then the built-in default. Emits a one-line notice on startup
 * so the operator can see which window is in effect.
 * @param {object} params
 * @param {number} [params.option] - Explicit --context-window value
 * @param {object} params.client - Model client (for probing)
 * @param {string} params.modelId - Resolved model id
 * @param {boolean} [params.quiet] - Suppress the startup notice
 * @returns {Promise<number>}
 */
export async function resolveContextWindow(params) {
  const { option, client, modelId, quiet = false } = params;

  const configured = configuredContextWindow(option);
  if (configured !== null) {
    return configured;
  }

  const { loaded, max } = await client.contextInfo(modelId);
  if (Number.isInteger(loaded) && loaded > 0) {
    if (!quiet) {
      process.stderr.write(
        `${formatNotice(`context window ${loaded} tokens (loaded for ${modelId})`)}\n`,
      );
      if (hasContextHeadroom(loaded, max)) {
        const factor = Math.floor(max / loaded);
        process.stderr.write(
          `${formatNotice(`${modelId} supports up to ${max} tokens (${factor}× more) — reload it with a larger context in LM Studio for longer sessions and fewer compactions. Costs more memory.`)}\n`,
        );
      }
    }
    return loaded;
  }

  if (!quiet) {
    process.stderr.write(
      `${formatNotice(`context window ${DEFAULT_CONTEXT_WINDOW} tokens (default; probe unavailable)`)}\n`,
    );
  }
  return DEFAULT_CONTEXT_WINDOW;
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
    packageCommands: result.packageCommands ?? [],
    toolTurns: result.toolTurns,
    stoppedReason: result.stoppedReason,
    usage: result.usage,
    compactions: result.compactions ?? null,
    error: result.error ?? null,
    verified: result.verification?.passed ?? null,
    healed: result.healed ?? null,
    healTurns: result.healTurns ?? null,
    messages: result.messages,
  };
}
