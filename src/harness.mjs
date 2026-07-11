/**
 * The harness — orchestrates the full run loop.
 * context → model + tools → verify → heal
 */

import { join, resolve } from 'node:path';
import { commitFiles, commitTimeoutMs, isGitRepo } from './commit.mjs';
import {
  compactMessages,
  configuredContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  isCompactCommand,
} from './compact.mjs';
import { buildSystemPrompt } from './context.mjs';
import { createDebugLogger, debugLogEnabled } from './debug-log.mjs';
import { buildEnv } from './env.mjs';
import { heal } from './heal.mjs';
import { createNullReporter, createTerminalReporter } from './reporter.mjs';
import {
  loadHooks,
  runSessionHooks,
  runStopHooks,
  sessionHooks,
  stopHooks,
  toolHooks,
} from './hooks.mjs';
import {
  incidentHeartbeatIntervalMs,
  installIncidentHandlers,
  sweepOrphanedHeartbeats,
} from './incident.mjs';
import { ensureModelLoaded } from './lms.mjs';
import {
  isMemoryEnabled,
  memorySizeCap,
  memorySizeNotice,
  readMemory,
  runMemoryRetrospective,
} from './memory.mjs';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  hasContextHeadroom,
} from './model.mjs';
import { createProvider, resolveProviderName } from './provider.mjs';
import { DEFAULT_OLLAMA_BASE_URL } from './provider-ollama.mjs';
import { DEFAULT_OPENROUTER_BASE_URL } from './provider-openrouter.mjs';
import {
  minReviewToolCalls,
  reviewMaxToolTurns,
  runReview,
} from './review.mjs';
import {
  isRunBudgetExceeded,
  MAX_TOOL_TURNS,
  remainingRunBudgetMs,
  runToolLoop,
} from './tool-loop.mjs';
import { createToolRegistry } from './tools/index.mjs';

// Re-exported for callers (and tests) that imported them from the harness.
export { isRunBudgetExceeded, remainingRunBudgetMs };

/**
 * Run the harness.
 * @param {string} prompt - User prompt
 * @param {object} options
 * @param {string} options.cwd - Workspace root (absolute path)
 * @param {string} [options.provider] - "lmstudio", "openrouter", or "ollama" (default lmstudio, or KODR_PROVIDER)
 * @param {string} [options.baseUrl] - Provider API base URL
 * @param {string} [options.model] - Model identifier
 * @param {boolean} [options.reasoning] - Request reasoning tokens; only openrouter
 *   supports this -- errors otherwise (see specs/provider.yaml)
 * @param {boolean} [options.noZdr] - Disable OpenRouter Zero Data Retention routing
 *   (on by default with the openrouter provider)
 * @param {boolean} [options.allowDataCollection] - Allow OpenRouter providers that
 *   collect/train on prompt data (denied by default with the openrouter provider)
 * @param {string[]} [options.providerOrder] - OpenRouter upstream provider slugs to
 *   try in order, e.g. ["akashml", "parasail"] (maps to provider.order)
 * @param {string} [options.testCommand] - Verification command
 * @param {number} [options.maxHealTurns] - Max heal turns (default 3)
 * @param {number} [options.maxRunMs] - Stop between turns after this many ms (0 disables)
 * @param {boolean} [options.quiet] - Suppress terminal output
 * @param {object} [options.reporter] - Output channel (see specs/reporter.yaml).
 *   Defaults to a terminal reporter, or a null (silent) reporter when quiet.
 *   The CLI passes a JSON reporter for --events.
 * @param {Array} [options.priorMessages] - Continuation from previous run
 * @param {string[]} [options.priorFilesChanged] - The continued run's own
 *   filesChanged, from its saved transcript -- seeds this session's tool
 *   registry so a raw-then-fix commit covers files the prior, interrupted
 *   attempt touched but never got to commit, not just files this specific
 *   session's own tool calls touch.
 * @param {string[]} [options.envPassthrough] - Extra env var names for commands
 * @param {number} [options.contextWindow] - Max context window in tokens (0 disables compaction)
 * @param {number} [options.healReserve] - Fraction of the run budget held back for heal (0..0.9; default KODR_HEAL_RESERVE or 0.25)
 * @param {number} [options.heartbeatMs] - Interval for Stop-hook "still running" notices (0 disables; default KODR_HEARTBEAT_MS or 30000)
 * @param {number} [options.maxRetries] - Retries for a 5xx chat response (0 disables; default KODR_MODEL_RETRIES or 1)
 * @param {string} [options.runsDir] - Where to write run transcripts (default cwd/.kodr/runs or KODR_RUNS_DIR)
 * @param {boolean} [options.noSave] - Skip writing the run transcript (also KODR_NO_SAVE)
 * @param {number} [options.incidentHeartbeatMs] - Interval for the on-disk heartbeat used
 *   to detect a run that never exited cleanly (0 disables; default KODR_INCIDENT_HEARTBEAT_MS
 *   or 30000). No effect when noSave is set.
 * @param {string} [options.reviewModel] - Review model. When set, Kodr owns the LM Studio
 *   load/unload/verify sequencing for both the build model and this one (see lms.mjs)
 *   instead of the operator swapping models by hand between phases, and a review pass
 *   runs after a successful build. Omitted (the default) changes nothing: a single
 *   model serves both roles and no lms shell-outs happen at all.
 * @param {number} [options.reviewContextWindow] - Context window for the review model
 *   (defaults to the build model's own contextWindow)
 * @param {number} [options.reviewMinToolCalls] - Tool-call floor before a review counts
 *   as grounded (default 2 — KODR_REVIEW_MIN_TOOL_CALLS; 0 disables the floor and its retry)
 * @param {number} [options.reviewMaxToolTurns] - Tool-turn ceiling per review attempt
 *   (default 12 — KODR_REVIEW_MAX_TOOL_TURNS)
 * @param {boolean} [options.rawThenFixCommits] - Commit the build phase's raw output as
 *   soon as the tool loop finishes, then commit whatever heal changes on top as a
 *   separate commit (also KODR_RAW_THEN_FIX_COMMITS). Off by default; skipped with a
 *   notice (not an error) when cwd isn't a git work tree.
 * @param {number} [options.commitTimeoutMs] - Timeout for each git call raw-then-fix
 *   commit mode makes (default 30 seconds — KODR_COMMIT_TIMEOUT_MS)
 * @param {boolean} [options.memory] - Run an end-of-run retrospective proposing lessons
 *   for future runs in this workspace (also KODR_MEMORY). Off by default. Never writes
 *   to MEMORY.md without a human decision — see specs/memory.yaml.
 * @param {number} [options.memoryReserve] - Fraction of the run budget the retrospective
 *   refuses to spend into, mirroring healReserve (default 0.1 — KODR_MEMORY_RESERVE)
 * @param {boolean} [options.memoryAttended] - Whether to prompt inline for confirmation
 *   (true when stdout is a TTY and neither --quiet nor --json is set); unattended runs
 *   write a proposal file instead
 * @param {boolean} [options.memoryAutoApply] - Skip the confirmation prompt and apply
 *   directly (--memory-auto-apply); opt-in only, never the default
 * @param {number} [options.memorySizeCap] - Size cap for MEMORY.md in characters, past
 *   which a notice (not truncation) is printed (default 8000 — KODR_MEMORY_SIZE_CAP)
 * @param {boolean} [options.debug] - Write every model request's raw request/response
 *   to a JSONL sidecar next to the run transcript (also KODR_DEBUG). Off by default;
 *   see specs/debug-log.yaml.
 * @param {boolean} [options.approveCommands] - Require confirm() approval before each
 *   run_command tool call (see specs/tui.yaml). Off by default.
 * @param {function} [options.confirm] - (call) => Promise<{ approved }>; the approval
 *   channel used when approveCommands is on (the TUI supplies this)
 * @returns {Promise<object>} Run result
 */
export async function run(prompt, options) {
  const startedAt = new Date();
  const {
    cwd,
    testCommand,
    maxHealTurns = 3,
    maxRunMs = 0,
    maxToolTurns = MAX_TOOL_TURNS,
    quiet = false,
    priorMessages,
    priorFilesChanged = [],
    envPassthrough = [],
  } = options;
  const runsDir = resolveRunsDir(cwd, options.runsDir);
  const rawThenFixCommits = rawThenFixCommitsEnabled(options.rawThenFixCommits);
  const noSave = isSaveDisabled(options.noSave);
  // The run's one-way output channel (specs/reporter.yaml). Constructed once
  // here at the harness boundary and threaded down; quiet just selects the
  // silent reporter. The CLI may inject its own (e.g. the --events JSON
  // reporter) via options.reporter.
  const reporter =
    options.reporter ??
    (quiet ? createNullReporter() : createTerminalReporter());

  // A previous run's leftover heartbeat is the only evidence of a true
  // SIGKILL or host crash, since nothing runs in-process at the moment
  // that happens -- sweep for one before this run writes its own.
  let disposeIncidentTracking = async () => {};
  if (!noSave) {
    await sweepOrphanedHeartbeats(runsDir).catch(() => {});
    disposeIncidentTracking = await installIncidentHandlers({
      runsDir,
      startedAt,
      heartbeatMs: incidentHeartbeatIntervalMs(options.incidentHeartbeatMs),
    });
  }

  // Provider setup (construction, model resolution, context-window probe,
  // and the optional review-model load) runs inside its own try/catch so a
  // failure here -- a bad provider config, an unresolvable model -- still
  // disposes incident tracking before propagating. Without this,
  // installIncidentHandlers' heartbeat file above is never cleaned up on a
  // setup-phase throw, and the *next* run's own sweepOrphanedHeartbeats
  // reports it as a false orphaned-run incident. Confirmed:
  // `run({ provider: 'openrouter' })` with no OPENROUTER_API_KEY used to
  // leak exactly this file.
  let client;
  let modelId;
  let contextWindow;
  try {
    client = createProvider({
      provider: options.provider,
      baseUrl: options.baseUrl,
      model: options.model,
      timeout: maxRunMs || undefined,
      maxRetries: modelMaxRetries(options.maxRetries),
      reasoning: options.reasoning,
      noZdr: options.noZdr,
      allowDataCollection: options.allowDataCollection,
      providerOrder: options.providerOrder,
    });

    modelId = await client.resolveModel();
    contextWindow = await resolveContextWindow({
      option: options.contextWindow,
      client,
      modelId,
      reporter,
    });

    // A review model means Kodr owns the LM Studio load/unload sequencing
    // itself, rather than the operator swapping models by hand between
    // phases -- the incident that motivated this was a run killed by the
    // model having silently reloaded at the wrong context size, diagnosed
    // by hand after the fact. With no review model configured (today's
    // default), none of this runs -- LM Studio's own on-demand loading is
    // unchanged. A provider with no model-lifecycle concept (e.g.
    // OpenRouter, where the model is just a per-request field) skips this
    // too -- there's nothing to load.
    if (options.reviewModel && client.capabilities.modelLifecycle) {
      const loadResult = await client.loadModel({
        model: modelId,
        contextWindow,
      });
      if (loadResult.error) {
        reporter.notice(`build model load: ${loadResult.error}`);
      }
    }
  } catch (err) {
    await disposeIncidentTracking();
    throw err;
  }

  const metadata = {
    cwd,
    prompt,
    provider: resolveProviderName(options.provider),
    baseUrl:
      options.baseUrl ||
      defaultBaseUrlFor(resolveProviderName(options.provider)),
    model: modelId,
    testCommand: testCommand || null,
    maxHealTurns,
    maxRunMs,
    maxToolTurns,
    envPassthrough,
    contextWindow,
    startedAt: startedAt.toISOString(),
  };
  const tools = createToolRegistry(cwd, {
    envPassthrough,
    startedAt,
    maxRunMs,
    vision: options.vision,
    initialFilesChanged: priorFilesChanged,
  });
  const commandEnv = buildEnv(envPassthrough);
  // Read once and pass the same content to both buildSystemPrompt and the
  // size-cap check below, rather than each reading MEMORY.md separately --
  // two independent reads could otherwise observe different content if a
  // concurrent process appended to it in between.
  const memoryContent = await readMemory(cwd);
  const systemPrompt = await buildSystemPrompt(cwd, { memory: memoryContent });

  // MEMORY.md is always loaded into the prompt above when it exists; this
  // never truncates it, just flags an oversized file so a human notices
  // and prunes instead of it growing unbounded with no signal either way.
  const sizeNotice = memorySizeNotice(
    memoryContent,
    memorySizeCap(options.memorySizeCap),
  );
  if (sizeNotice) {
    reporter.notice(sizeNotice);
  }

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

  const heartbeatMs = heartbeatIntervalMs(options.heartbeatMs);
  // Kept gated on quiet (not folded into the reporter) so the heartbeat timer
  // in model.mjs isn't even scheduled when there's nothing to render.
  const onModelHeartbeat = quiet
    ? undefined
    : (elapsedMs) => reporter.heartbeat({ label: 'model response', elapsedMs });
  // --debug (or KODR_DEBUG) writes every model request's raw request/response
  // to a JSONL sidecar next to the run transcript -- not gated by noSave,
  // since --debug is itself an explicit request for on-disk output.
  const onModelDebug = debugLogEnabled(options.debug)
    ? createDebugLogger(runsDir, startedAt)
    : undefined;

  // On-demand compaction: "/compact" compresses the prior conversation
  // instead of running a new task.
  if (isCompactCommand(prompt)) {
    reporter.phase('compact');
    const compactionResult = await runManualCompaction({
      client,
      modelId,
      cwd,
      messages,
      metadata,
      reporter,
      startedAt,
      maxRunMs,
      runsDir,
      noSave,
      heartbeatMs,
      onHeartbeat: onModelHeartbeat,
      onDebug: onModelDebug,
    });
    await disposeIncidentTracking();
    return compactionResult;
  }

  // Hooks are loaded once: SessionStart primes the conversation, Stop hooks
  // gate completion, tool hooks fire inside the loop (and during heal), and
  // SessionEnd runs as the session closes.
  const { config: hooksConfig, error: hooksError } = await loadHooks(cwd);
  if (hooksError) {
    reporter.notice(hooksError);
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
    reporter,
  });

  messages.push({ role: 'user', content: prompt });

  let result;
  try {
    // Run the tool loop
    reporter.phase('build');
    const loop = await runToolLoop({
      client,
      modelId,
      messages,
      tools,
      reporter,
      startedAt,
      maxRunMs,
      maxToolTurns,
      contextWindow,
      toolHooks: toolHookSets,
      cwd,
      commandEnv,
      heartbeatMs,
      onHeartbeat: onModelHeartbeat,
      onDebug: onModelDebug,
      approveCommands: options.approveCommands,
      confirm: options.confirm,
    });
    const totalUsage = loop.usage;
    const { completed, stoppedReason, toolTurns } = loop;
    let compactions = loop.compactions;
    let totalRetries = loop.retries || 0;

    // The model never produced a final response — it ran out of turns or budget.
    if (!completed) {
      reporter.notice(formatStopReason(stoppedReason, maxToolTurns));
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
      retries: totalRetries,
      messages,
    };

    // Raw-then-fix commit mode: commit exactly what the model just
    // produced, before any heal pass has a chance to touch the same
    // files -- runs regardless of stoppedReason, since an incomplete run
    // (tool-limit, budget-exceeded) still deserves its raw output
    // committed rather than left to a heal pass that may never run.
    let isRepo;
    if (rawThenFixCommits) {
      result.commits = {};
      isRepo = await isGitRepo(cwd, {
        env: commandEnv,
        timeoutMs: commitTimeoutMs(options.commitTimeoutMs),
      });
      if (!isRepo) {
        reporter.notice('raw-then-fix commits skipped: not a git repository');
      } else {
        result.commits.raw = await commitFiles({
          cwd,
          files: tools.filesChanged(),
          message: 'kodr: raw build output',
          env: commandEnv,
          timeoutMs: commitTimeoutMs(options.commitTimeoutMs),
        });
        if (result.commits.raw.error) {
          reporter.notice(`raw commit failed: ${result.commits.raw.error}`);
        }
      }
    }

    // Stop hooks: run when the agent finishes a turn. The `--test` command is
    // the first Stop hook, followed by any in .kodr/hooks.json. Each hook gates
    // on whether the workspace was touched (writes or shell commands), unless it
    // opts in with runWhenUnchanged. A failing blocking hook feeds back to heal.
    if (stoppedReason === 'complete') {
      const touchedWorkspace =
        tools.filesChanged().length > 0 || tools.commandsRun() > 0;
      // A run can legitimately finish untouched (a question-answering task),
      // so this is a visible signal, not a failure -- but it looks identical
      // to a quiet real success unless called out, which let a compaction-
      // derailed run report a normal "complete" stop with nothing done.
      result.noOpCompletion = !touchedWorkspace;
      if (!touchedWorkspace) {
        reporter.notice(
          'agent finished with no files changed and no commands run',
        );
      }
      // The initial verify is capped to leave a heal reserve, so a hook that
      // hangs cannot consume the whole budget and starve repair. Heal's own
      // re-verifies use the full remaining budget (the reserve plus leftover).
      const runHooks = (budgetMs) =>
        runStopHooks(stops, cwd, {
          env: commandEnv,
          budgetMs,
          touchedWorkspace,
          heartbeatMs,
          // Gated on quiet (like the model heartbeat) so no timer is scheduled
          // when there's nothing to render.
          onHeartbeat: quiet
            ? undefined
            : (name, elapsedMs) =>
                reporter.heartbeat({ label: name, elapsedMs }),
        });

      reporter.phase('verify');
      const hookResult = await runHooks(
        stopVerifyBudgetMs(startedAt, maxRunMs, reserveFraction),
      );
      // Only treat hooks as verification when at least one actually ran.
      if (hookResult.results.length > 0) {
        result.verification = hookResult;
        reporter.verification(hookResult);
      }

      // Heal if a blocking hook failed
      if (
        hookResult.results.length > 0 &&
        !hookResult.passed &&
        !isRunBudgetExceeded(startedAt, maxRunMs)
      ) {
        reporter.phase('heal');
        const healResult = await heal({
          client,
          modelId,
          messages,
          tools,
          verifyFn: () => runHooks(remainingRunBudgetMs(startedAt, maxRunMs)),
          failure: hookResult,
          maxTurns: maxHealTurns,
          reporter,
          startedAt,
          maxRunMs,
          maxToolTurns,
          contextWindow,
          toolHooks: toolHookSets,
          cwd,
          commandEnv,
          heartbeatMs,
          onHeartbeat: onModelHeartbeat,
          onDebug: onModelDebug,
          approveCommands: options.approveCommands,
          confirm: options.confirm,
        });

        result.healed = healResult.healed;
        result.healTurns = healResult.turns;
        result.verification = healResult.verification;
        compactions += healResult.compactions || 0;
        result.compactions = compactions;
        result.packageCommands = tools.packageCommands();
        totalUsage.prompt += healResult.usage.prompt;
        totalUsage.completion += healResult.usage.completion;
        totalUsage.cost += healResult.usage.cost || 0;
        totalRetries += healResult.retries || 0;
        result.retries = totalRetries;

        // Fix commit: reuses the same file list as the raw commit, not a
        // computed delta -- the raw commit already captured that state,
        // so a second add+commit of the identical list only ever picks
        // up whatever changed since, including a file heal edited that
        // build had already touched. A clean skip if heal made no
        // further changes.
        if (rawThenFixCommits && isRepo) {
          result.commits.fix = await commitFiles({
            cwd,
            files: tools.filesChanged(),
            message: 'kodr: heal fix',
            env: commandEnv,
            timeoutMs: commitTimeoutMs(options.commitTimeoutMs),
          });
          if (result.commits.fix.error) {
            reporter.notice(`fix commit failed: ${result.commits.fix.error}`);
          }
        }
      }
    }
  } catch (err) {
    // A raw commit may have already landed for real before this throw --
    // preserve it rather than losing the only record of it along with the
    // rest of the (now-discarded) in-progress result.
    const commitsBeforeError = result?.commits;
    result = createErrorResult({
      metadata,
      err,
      messages,
      tools,
    });
    if (commitsBeforeError) {
      result.commits = commitsBeforeError;
    }
    reporter.notice(`run failed: ${err.message}`);
  }

  // Both post-build steps below (review pass, memory retrospective)
  // already protect against their OWN internal errors -- runReviewPass
  // and runMemoryRetrospective's own try/catch never let a model/tool
  // failure propagate. This outer try/catch is a last-resort net for
  // something more fundamental in the glue code around them (a notice
  // write, a usage-accumulation bug) so it can't take an otherwise-
  // successful build result down with it.
  try {
    // Review pass: a fresh tool-loop conversation over what the build phase
    // changed, on the review model if one's configured. Never lets a review
    // failure overwrite an otherwise-successful build result -- it's an
    // added opinion, not part of the outcome the run is judged on.
    if (options.reviewModel && result.stoppedReason === 'complete') {
      reporter.phase('review');
      result.review = await runReviewPass({
        cwd,
        client,
        reviewModel: options.reviewModel,
        reviewContextWindow: options.reviewContextWindow,
        buildContextWindow: contextWindow,
        filesChanged: tools.filesChanged(),
        startedAt,
        maxRunMs,
        heartbeatMs,
        onHeartbeat: onModelHeartbeat,
        onDebug: onModelDebug,
        envPassthrough,
        minToolCalls: options.reviewMinToolCalls,
        maxToolTurns: options.reviewMaxToolTurns,
        reporter,
      });
      if (result.review.usage) {
        result.usage.prompt += result.review.usage.prompt;
        result.usage.completion += result.review.usage.completion;
        result.usage.cost += result.review.usage.cost || 0;
      }
      if (result.review.retries) {
        result.retries = (result.retries || 0) + result.review.retries;
      }
    } else if (options.reviewModel) {
      // A review model is configured but the build itself didn't reach
      // 'complete' (a timeout, a hang recovered externally, tool-limit,
      // budget-exceeded) -- reviewing a build that didn't finish isn't
      // meaningful, so the pass is skipped outright rather than attempted.
      // Recorded explicitly rather than left as the same undefined a run
      // with no --review-model at all would show, so --json output (and
      // anyone reading it later) can tell "no review configured" apart
      // from "configured, but never got to run."
      result.review = reviewSkippedForIncompleteBuild(result.stoppedReason);
    }

    // End-of-run retrospective: never writes to MEMORY.md without a human
    // decision in the loop (see specs/memory.yaml). Off by default. Unlike
    // incident telemetry, noSave only skips the unattended proposal-file
    // write (runMemoryRetrospective handles that internally) rather than
    // the whole feature -- --memory-auto-apply writes directly to
    // MEMORY.md at the workspace root, unrelated to runsDir hygiene, and
    // must keep working under --no-save.
    if (isMemoryEnabled(options.memory)) {
      reporter.phase('memory');
      try {
        result.memory = await runMemoryRetrospective({
          client,
          modelId,
          messages,
          cwd,
          startedAt,
          maxRunMs,
          memoryReserve: options.memoryReserve,
          toolTurns: result.toolTurns,
          runsDir,
          attended: options.memoryAttended,
          autoApply: options.memoryAutoApply,
          noSave,
        });
      } catch (err) {
        result.memory = { proposed: false, error: err.message };
      }

      if (result.memory.error) {
        reporter.notice(`memory retrospective failed: ${result.memory.error}`);
      } else if (result.memory.proposalPath) {
        reporter.notice(
          `memory proposal written: ${result.memory.proposalPath}`,
        );
      } else if (result.memory.applied) {
        reporter.notice('memory notes applied to MEMORY.md');
      }

      if (result.memory.usage) {
        result.usage.prompt += result.memory.usage.prompt;
        result.usage.completion += result.memory.usage.completion;
        result.usage.cost += result.memory.usage.cost || 0;
      }
      if (result.memory.retries) {
        result.retries = (result.retries || 0) + result.memory.retries;
      }
    }
  } catch (err) {
    reporter.notice(`post-build step failed: ${err.message}`);
  }

  // Save run transcript (unless disabled — e.g. running inside a benchmark
  // container where the workspace must stay clean).
  if (!noSave) {
    await saveRun(runsDir, result, startedAt);
  }

  // SessionEnd: cleanup as the session closes. Non-blocking, runs even on
  // error, and is not capped by the run budget (cleanup should still happen).
  await runSessionEnd({ hooks: endHooks, cwd, commandEnv, reporter });

  reporter.summary(result);

  await disposeIncidentTracking();
  return result;
}

/**
 * Run SessionStart hooks before the task prompt. Successful hook output is
 * injected as context messages so the model sees it; failures surface a notice.
 * @param {object} params
 */
async function runSessionStart(params) {
  const { hooks, cwd, commandEnv, messages, startedAt, maxRunMs, reporter } =
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
  for (const failure of failures) {
    reporter.notice(
      `SessionStart hook "${failure.name}" failed: ${failure.output}`,
    );
  }
}

/**
 * Run SessionEnd hooks as the session closes. Side effects only; failures
 * surface a notice. Not capped by the run budget.
 * @param {object} params
 */
async function runSessionEnd(params) {
  const { hooks, cwd, commandEnv, reporter } = params;
  if (hooks.length === 0) {
    return;
  }

  const { failures } = await runSessionHooks(hooks, cwd, { env: commandEnv });
  for (const failure of failures) {
    reporter.notice(
      `SessionEnd hook "${failure.name}" failed: ${failure.output}`,
    );
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
    // Work done before the failure is preserved: runToolLoop attaches the
    // usage/turns it accumulated to the error, so a run that did real
    // (paid) turns before throwing is not booked as toolTurns: 0, cost: 0.
    toolTurns: err.toolTurns ?? 0,
    stoppedReason: 'error',
    usage: err.usage ?? { prompt: 0, completion: 0, cost: 0 },
    compactions: err.compactions ?? 0,
    retries: err.retries ?? 0,
    messages,
  };
}

export const DEFAULT_HEARTBEAT_MS = 30_000; // 30 seconds

/**
 * Interval for Stop-hook heartbeat notices, so a legitimately slow command
 * (a big test suite, a cold build) doesn't look indistinguishable from a
 * stuck harness during the wait — see verify's DEFAULT_TIMEOUT (10 minutes),
 * which is otherwise silent for its whole duration. Resolved from an
 * explicit option, then KODR_HEARTBEAT_MS, then the default; 0 disables.
 * @param {number} [option]
 * @returns {number}
 */
export function heartbeatIntervalMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_HEARTBEAT_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_HEARTBEAT_MS;
}

/**
 * Retries for a 5xx chat response, so a one-off local-backend crash (see
 * model.mjs's isRetryableServerError) doesn't fail the whole run. Resolved
 * from an explicit option, then KODR_MODEL_RETRIES, then model.mjs's
 * default; 0 disables.
 * @param {number} [option]
 * @returns {number}
 */
export function modelMaxRetries(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_MODEL_RETRIES, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_MAX_RETRIES;
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
  const { client, modelId, messages, metadata, reporter, startedAt } = params;
  const { runsDir, noSave, maxRunMs = 0, heartbeatMs, onHeartbeat } = params;
  const { onDebug } = params;

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
    reporter.notice(result.response);
    return result;
  }

  const compactResult = await compactMessages({
    client,
    modelId,
    messages,
    reporter,
    timeoutMs: remainingRunBudgetMs(startedAt, maxRunMs),
    heartbeatMs,
    onHeartbeat,
    onDebug,
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
  reporter.summary(result);
  return result;
}

function emptyCompactionResult(metadata, messages, response) {
  return {
    metadata,
    response,
    filesChanged: [],
    toolTurns: 0,
    stoppedReason: 'complete',
    usage: { prompt: 0, completion: 0, cost: 0 },
    compactions: 0,
    messages,
  };
}

/**
 * The result.review value for a run where a review model is configured
 * but the build never reached 'complete', so runReviewPass was never
 * called at all. Kept as its own function (rather than inlined) so it's
 * directly unit-testable without needing to drive a full run() through
 * the real, non-injectable ensureModelLoaded call that a truthy
 * options.reviewModel otherwise triggers at the top of run().
 * @param {string} stoppedReason
 * @returns {{ skipped: true, reason: string }}
 */
export function reviewSkippedForIncompleteBuild(stoppedReason) {
  return {
    skipped: true,
    reason: `build did not complete (stoppedReason: ${stoppedReason})`,
  };
}

/**
 * Orchestrates the review pass: switch to the review model, run the
 * review, and never let a failure in either step escape as a thrown
 * error -- a review is an added opinion, not part of the outcome the run
 * is judged on. `ensureModelLoadedFn`/`runReviewFn` are only ever
 * overridden in tests, to prove that guarantee holds even if either step
 * throws, without needing a real lms binary or model server to do it.
 * @param {object} params
 * @param {function} [params.ensureModelLoadedFn]
 * @param {function} [params.runReviewFn]
 */
export async function runReviewPass(params) {
  const {
    cwd,
    client,
    reviewModel,
    reviewContextWindow,
    buildContextWindow,
    filesChanged,
    startedAt,
    maxRunMs,
    heartbeatMs,
    onHeartbeat,
    onDebug,
    envPassthrough,
    minToolCalls,
    maxToolTurns,
    reporter = createNullReporter(),
    ensureModelLoadedFn = ensureModelLoaded,
    runReviewFn = runReview,
  } = params;
  // reviewContextWindow is explicitly "unset" only when it's null/undefined
  // -- 0 is a legitimate value (this repo's own "0 disables" convention),
  // and `|| buildContextWindow` would otherwise silently override it.
  const contextWindow = Number.isInteger(reviewContextWindow)
    ? reviewContextWindow
    : buildContextWindow;

  try {
    // A provider with no model-lifecycle concept (e.g. OpenRouter) needs no
    // load step -- the review model is just a different value in the chat
    // request's `model` field, not something that has to be loaded first.
    if (client.capabilities.modelLifecycle) {
      const loadResult = await ensureModelLoadedFn({
        model: reviewModel,
        contextWindow,
      });
      if (loadResult.error) {
        reporter.notice(`review skipped: ${loadResult.error}`);
        return { skipped: true, error: loadResult.error };
      }
    }

    const reviewResult = await runReviewFn({
      client,
      modelId: reviewModel,
      cwd,
      filesChanged,
      startedAt,
      maxRunMs,
      contextWindow,
      heartbeatMs,
      onHeartbeat,
      onDebug,
      envPassthrough,
      minToolCalls: minReviewToolCalls(minToolCalls),
      maxToolTurns: reviewMaxToolTurns(maxToolTurns),
    });

    if (!reviewResult.skipped) {
      const status = reviewResult.grounded
        ? 'review complete'
        : 'review complete (ungrounded -- treat with caution)';
      reporter.notice(status);
    }
    return reviewResult;
  } catch (err) {
    reporter.notice(`review failed: ${err.message}`);
    return { skipped: true, error: err.message };
  }
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
 * @param {object} [params.reporter] - Output channel for the startup notice
 *   (see specs/reporter.yaml); defaults to a null (silent) reporter
 * @returns {Promise<number>}
 */
export async function resolveContextWindow(params) {
  const { option, client, modelId, reporter = createNullReporter() } = params;

  const configured = configuredContextWindow(option);
  if (configured !== null) {
    return configured;
  }

  const { loaded, max } = await client.contextInfo(modelId);
  if (Number.isInteger(loaded) && loaded > 0) {
    reporter.notice(`context window ${loaded} tokens (loaded for ${modelId})`);
    if (hasContextHeadroom(loaded, max)) {
      const factor = Math.floor(max / loaded);
      reporter.notice(
        `${modelId} supports up to ${max} tokens (${factor}× more) — reload it with a larger context in LM Studio for longer sessions and fewer compactions. Costs more memory.`,
      );
    }
    return loaded;
  }

  reporter.notice(
    `context window ${DEFAULT_CONTEXT_WINDOW} tokens (default; probe unavailable)`,
  );
  return DEFAULT_CONTEXT_WINDOW;
}

function formatStopReason(stoppedReason, maxToolTurns) {
  if (stoppedReason === 'budget-exceeded') {
    return 'stopped after run budget';
  }
  return `stopped after ${maxToolTurns} tool turns`;
}

/**
 * The default base URL for a resolved provider name, for recording in run
 * metadata when no explicit --base-url was given.
 * @param {string} providerName
 * @returns {string}
 */
function defaultBaseUrlFor(providerName) {
  if (providerName === 'openrouter') {
    return DEFAULT_OPENROUTER_BASE_URL;
  }
  if (providerName === 'ollama') {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  return DEFAULT_BASE_URL;
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

/**
 * Whether raw-then-fix commit mode is on, via the rawThenFixCommits
 * option or KODR_RAW_THEN_FIX_COMMITS ("1"/"true"). Off by default.
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function rawThenFixCommitsEnabled(option) {
  if (option === true) {
    return true;
  }
  const env = process.env.KODR_RAW_THEN_FIX_COMMITS;
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
    retries: result.retries ?? 0,
    error: result.error ?? null,
    verified: result.verification?.passed ?? null,
    noOpCompletion: result.noOpCompletion ?? false,
    healed: result.healed ?? null,
    healTurns: result.healTurns ?? null,
    messages: result.messages,
  };
}
