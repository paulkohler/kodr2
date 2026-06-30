/**
 * The harness — orchestrates the full run loop.
 * context → model + tools → verify → heal
 */

import { join, resolve } from 'node:path';
import { buildSystemPrompt } from './context.mjs';
import { createClient, hasContextHeadroom } from './model.mjs';
import { createToolRegistry } from './tools/index.mjs';
import { buildEnv } from './env.mjs';
import {
  loadHooks,
  runSessionHooks,
  runStopHooks,
  sessionHooks,
  stopHooks,
  toolHooks,
} from './hooks.mjs';
import { heal } from './heal.mjs';
import {
  MAX_TOOL_TURNS,
  isRunBudgetExceeded,
  remainingRunBudgetMs,
  runToolLoop,
} from './tool-loop.mjs';
import { formatNotice, formatVerification, formatSummary } from './format.mjs';
import {
  DEFAULT_CONTEXT_WINDOW,
  compactMessages,
  configuredContextWindow,
  isCompactCommand,
} from './compact.mjs';

// Re-exported for callers (and tests) that imported them from the harness.
export { isRunBudgetExceeded, remainingRunBudgetMs };

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
 * @param {number} [options.healReserve] - Fraction of the run budget held back for heal (0..0.9; default KODR_HEAL_RESERVE or 0.25)
 * @param {string} [options.runsDir] - Where to write run transcripts (default cwd/.kodr/runs or KODR_RUNS_DIR)
 * @param {boolean} [options.noSave] - Skip writing the run transcript (also KODR_NO_SAVE)
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
  const runsDir = resolveRunsDir(cwd, options.runsDir);
  const noSave = isSaveDisabled(options.noSave);

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
      runsDir,
      noSave,
    });
  }

  // Hooks are loaded once: SessionStart primes the conversation, Stop hooks
  // gate completion, tool hooks fire inside the loop (and during heal), and
  // SessionEnd runs as the session closes.
  const { config: hooksConfig, error: hooksError } = await loadHooks(cwd);
  if (hooksError && !quiet) {
    process.stderr.write(`${formatNotice(hooksError)}\n`);
  }
  const stops = stopHooks(hooksConfig, testCommand);
  const toolHookSets = {
    PreToolUse: toolHooks(hooksConfig, 'PreToolUse'),
    PostToolUse: toolHooks(hooksConfig, 'PostToolUse'),
  };
  const endHooks = sessionHooks(hooksConfig, 'SessionEnd');
  const reserveFraction = healReserveFraction(options.healReserve);

  // SessionStart: run before the task prompt so its output primes the model.
  await runSessionStart({
    hooks: sessionHooks(hooksConfig, 'SessionStart'),
    cwd,
    commandEnv,
    messages,
    startedAt,
    maxRunMs,
    quiet,
  });

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
      toolHooks: toolHookSets,
      cwd,
      commandEnv,
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

    // Stop hooks: run when the agent finishes a turn. The `--test` command is
    // the first Stop hook, followed by any in .kodr/hooks.json. Each hook gates
    // on whether the workspace was touched (writes or shell commands), unless it
    // opts in with runWhenUnchanged. A failing blocking hook feeds back to heal.
    if (stoppedReason === 'complete') {
      const touchedWorkspace =
        tools.filesChanged().length > 0 || tools.commandsRun() > 0;
      // The initial verify is capped to leave a heal reserve, so a hook that
      // hangs cannot consume the whole budget and starve repair. Heal's own
      // re-verifies use the full remaining budget (the reserve plus leftover).
      const runHooks = (budgetMs) =>
        runStopHooks(stops, cwd, {
          env: commandEnv,
          budgetMs,
          touchedWorkspace,
        });

      const hookResult = await runHooks(
        stopVerifyBudgetMs(startedAt, maxRunMs, reserveFraction),
      );
      // Only treat hooks as verification when at least one actually ran.
      if (hookResult.results.length > 0) {
        result.verification = hookResult;

        if (!quiet) {
          process.stderr.write(`${formatVerification(hookResult)}\n`);
        }
      }

      // Heal if a blocking hook failed
      if (
        hookResult.results.length > 0 &&
        !hookResult.passed &&
        !isRunBudgetExceeded(startedAt, maxRunMs)
      ) {
        const healResult = await heal({
          client,
          modelId,
          messages,
          tools,
          verifyFn: () => runHooks(remainingRunBudgetMs(startedAt, maxRunMs)),
          failure: hookResult,
          maxTurns: maxHealTurns,
          quiet,
          startedAt,
          maxRunMs,
          contextWindow,
          toolHooks: toolHookSets,
          cwd,
          commandEnv,
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

  // Save run transcript (unless disabled — e.g. running inside a benchmark
  // container where the workspace must stay clean).
  if (!noSave) {
    await saveRun(runsDir, result, startedAt);
  }

  // SessionEnd: cleanup as the session closes. Non-blocking, runs even on
  // error, and is not capped by the run budget (cleanup should still happen).
  await runSessionEnd({ hooks: endHooks, cwd, commandEnv, quiet });

  if (!quiet) {
    process.stderr.write(`${formatSummary(result)}\n`);
  }

  return result;
}

/**
 * Run SessionStart hooks before the task prompt. Successful hook output is
 * injected as context messages so the model sees it; failures surface a notice.
 * @param {object} params
 */
async function runSessionStart(params) {
  const { hooks, cwd, commandEnv, messages, startedAt, maxRunMs, quiet } =
    params;
  if (hooks.length === 0) {
    return;
  }

  const { context, failures } = await runSessionHooks(hooks, cwd, {
    env: commandEnv,
    budgetMs: remainingRunBudgetMs(startedAt, maxRunMs),
  });

  for (const item of context) {
    messages.push({
      role: 'user',
      content: `SessionStart hook "${item.name}" output:\n${item.output}`,
    });
  }
  if (!quiet) {
    for (const failure of failures) {
      process.stderr.write(
        `${formatNotice(`SessionStart hook "${failure.name}" failed: ${failure.output}`)}\n`,
      );
    }
  }
}

/**
 * Run SessionEnd hooks as the session closes. Side effects only; failures
 * surface a notice. Not capped by the run budget.
 * @param {object} params
 */
async function runSessionEnd(params) {
  const { hooks, cwd, commandEnv, quiet } = params;
  if (hooks.length === 0) {
    return;
  }

  const { failures } = await runSessionHooks(hooks, cwd, { env: commandEnv });
  if (!quiet) {
    for (const failure of failures) {
      process.stderr.write(
        `${formatNotice(`SessionEnd hook "${failure.name}" failed: ${failure.output}`)}\n`,
      );
    }
  }
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

export const DEFAULT_HEAL_RESERVE = 0.25;

/**
 * Fraction of the run budget held back from the initial verification so the
 * heal pass still has time to run. A pathological Stop hook (e.g. a test that
 * hangs on an open handle) can otherwise consume the whole budget and starve
 * repair. Resolved from an explicit option, then KODR_HEAL_RESERVE, then the
 * default; clamped to [0, 0.9].
 * @param {number} [option]
 * @returns {number}
 */
export function healReserveFraction(option) {
  let fraction = DEFAULT_HEAL_RESERVE;
  const fromEnv = parseFraction(process.env.KODR_HEAL_RESERVE);
  if (Number.isFinite(fromEnv)) {
    fraction = fromEnv;
  }
  if (Number.isFinite(option)) {
    fraction = option;
  }
  if (fraction < 0) {
    return 0;
  }
  if (fraction > 0.9) {
    return 0.9;
  }
  return fraction;
}

function parseFraction(value) {
  if (value === undefined || value === '') {
    return Number.NaN;
  }
  return Number.parseFloat(value);
}

/**
 * Budget cap for the initial Stop-hook verification: the remaining run budget
 * minus the heal reserve. Returns undefined when no run budget is set, so the
 * verify falls back to its own default timeout.
 * @param {Date} startedAt
 * @param {number} maxRunMs
 * @param {number} reserveFraction
 * @returns {number | undefined}
 */
export function stopVerifyBudgetMs(startedAt, maxRunMs, reserveFraction) {
  const remaining = remainingRunBudgetMs(startedAt, maxRunMs);
  if (remaining === undefined) {
    return undefined;
  }
  return Math.max(1, Math.floor(remaining * (1 - reserveFraction)));
}

/**
 * On-demand compaction. Compresses the prior conversation in `messages` and
 * saves the result as a run, rather than running a new task.
 * @param {object} params
 * @returns {Promise<object>} Run result
 */
async function runManualCompaction(params) {
  const { client, modelId, messages, metadata, quiet, startedAt } = params;
  const { runsDir, noSave } = params;

  // messages holds the fresh system prompt plus any continued conversation.
  const hasHistory = messages.some((message) => message.role !== 'system');
  if (!hasHistory) {
    const result = emptyCompactionResult(
      metadata,
      messages,
      'Nothing to compact — no prior conversation. Use --continue to load one.',
    );
    if (!noSave) {
      await saveRun(runsDir, result, startedAt);
    }
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

  if (!noSave) {
    await saveRun(runsDir, result, startedAt);
  }
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

/**
 * Where run transcripts are written. Precedence: an explicit option, then
 * KODR_RUNS_DIR, then the default cwd/.kodr/runs. A relative override resolves
 * against cwd. Lets a benchmark/container run redirect artifacts out of the
 * task workspace so they don't pollute it (or break byte-exact verifiers).
 * @param {string} cwd
 * @param {string} [option]
 * @returns {string}
 */
export function resolveRunsDir(cwd, option) {
  const override = option || process.env.KODR_RUNS_DIR;
  if (override) {
    return resolve(cwd, override);
  }
  return join(cwd, '.kodr', 'runs');
}

/**
 * Whether run-transcript saving is disabled, via the noSave option or
 * KODR_NO_SAVE ("1"/"true").
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function isSaveDisabled(option) {
  if (option === true) {
    return true;
  }
  const env = process.env.KODR_NO_SAVE;
  return env === '1' || env === 'true';
}

async function saveRun(runsDir, result, startedAt) {
  const { mkdir, writeFile } = await import('node:fs/promises');

  await mkdir(runsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(runsDir, `${timestamp}.json`);

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
