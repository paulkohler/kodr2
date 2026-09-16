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
import {
  buildSystemPrompt,
  instructionsSizeCap,
  instructionsSizeNotice,
  readInstructions,
} from './context.mjs';
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
import { discoverSkills } from './skills.mjs';
import { DEFAULT_OLLAMA_BASE_URL } from './provider-ollama.mjs';
import { DEFAULT_OPENROUTER_BASE_URL } from './provider-openrouter.mjs';
import {
  minReviewToolCalls,
  reviewBaseUrlFor,
  reviewEndpoint,
  reviewProviderName,
  reviewMaxToolTurns,
  reviewSwapEnabled,
  runReview,
} from './review.mjs';
import {
  isCostBudgetExceeded,
  isRunBudgetExceeded,
  MAX_TOOL_TURNS,
  maxCostUsd,
  remainingRunBudgetMs,
  runCancelled,
  runToolLoop,
} from './tool-loop.mjs';
import { createToolRegistry } from './tools/index.mjs';

// Re-exported for callers (and tests) that imported them from the harness.
export {
  isCostBudgetExceeded,
  isRunBudgetExceeded,
  maxCostUsd,
  remainingRunBudgetMs,
  runCancelled,
};

/** @typedef {Parameters<typeof run>[1]} RunOptions */

/**
 * @typedef {object} RunMetadata
 * @property {string} cwd
 * @property {string} prompt
 * @property {string} provider
 * @property {string} baseUrl
 * @property {string} model
 * @property {string|null} reviewModel
 * @property {string|null} reviewProvider
 * @property {string|null} reviewBaseUrl
 * @property {string|null} testCommand
 * @property {number} maxHealTurns
 * @property {number} maxRunMs
 * @property {number} maxCostUsd
 * @property {number} maxToolTurns
 * @property {string[]} envPassthrough
 * @property {number} contextWindow
 * @property {string} startedAt
 */

/**
 * @typedef {object} RunResult
 * @property {RunMetadata} [metadata]
 * @property {string} [response]
 * @property {{ message: string, name?: string, stack?: string }} [error]
 * @property {string[]} [filesChanged]
 * @property {string[]} [packageCommands]
 * @property {number} [toolTurns]
 * @property {string} [stoppedReason]
 * @property {{ prompt: number, completion: number, cost: number }} [usage]
 * @property {number} [compactions]
 * @property {number} [retries]
 * @property {Array} [messages]
 * @property {Array} [toolDefinitions]
 * @property {{ raw?: object, fix?: object }} [commits]
 * @property {boolean} [noOpCompletion]
 * @property {{ passed: boolean }} [verification]
 * @property {boolean} [healed]
 * @property {number} [healTurns]
 * @property {import('./review.mjs').ReviewResult|{ skipped: true, reason: string }} [review]
 * @property {import('./memory.mjs').MemoryRetrospective} [memory]
 */

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
 * @param {boolean} [options.vision] - Offer the view_image tool (see specs/vision.yaml)
 * @param {number} [options.maxToolTurns] - Tool-turn ceiling per loop (default MAX_TOOL_TURNS)
 * @param {number} [options.maxRepeatToolErrors] - Consecutive identical (tool, error)
 *   failures before the loop gives up with stoppedReason "stuck" (default 3; 0
 *   disables, also KODR_MAX_REPEAT_TOOL_ERRORS)
 * @param {boolean} [options.noZdr] - Disable OpenRouter Zero Data Retention routing
 *   (on by default with the openrouter provider)
 * @param {boolean} [options.allowDataCollection] - Allow OpenRouter providers that
 *   collect/train on prompt data (denied by default with the openrouter provider)
 * @param {string[]} [options.providerOrder] - OpenRouter upstream provider slugs to
 *   try in order, e.g. ["akashml", "parasail"] (maps to provider.order)
 * @param {boolean} [options.cache] - Enable Anthropic prompt caching via a
 *   root-level cache_control field on OpenRouter (on by default for
 *   Anthropic-family models; off otherwise; also KODR_CACHE). See
 *   specs/provider-cache.yaml.
 * @param {string} [options.testCommand] - Verification command
 * @param {number} [options.maxHealTurns] - Max heal turns (default 3)
 * @param {number} [options.maxRunMs] - Stop between turns after this many ms (0 disables)
 * @param {number} [options.requestTimeoutMs] - Hard per-request timeout ceiling,
 *   independent of maxRunMs, so a stalled backend fails one request instead of
 *   hanging (default 10 minutes; positive only, also KODR_REQUEST_TIMEOUT_MS)
 * @param {boolean} [options.quiet] - Suppress terminal output
 * @param {import('./reporter.mjs').Reporter} [options.reporter] - Output channel
 *   (see specs/reporter.yaml). Defaults to a terminal reporter, or a null
 *   (silent) reporter when quiet. The CLI passes a JSON reporter for --events.
 * @param {Array} [options.priorMessages] - Continuation from previous run
 * @param {string[]} [options.priorFilesChanged] - The continued run's own
 *   filesChanged, from its saved transcript -- seeds this session's tool
 *   registry so a raw-then-fix commit covers files the prior, interrupted
 *   attempt touched but never got to commit, not just files this specific
 *   session's own tool calls touch.
 * @param {string[]} [options.envPassthrough] - Extra env var names for commands
 * @param {number} [options.contextWindow] - Max context window in tokens (0 disables compaction)
 * @param {number} [options.maxCostUsd] - Spend ceiling for the whole run in USD,
 *   covering the build loop, heal, the review pass and the memory retrospective
 *   (0 disables — the default — also KODR_MAX_COST_USD). Only as good as the
 *   provider's reported cost: LM Studio and Ollama report none, so it is inert
 *   there. Belt-and-braces beside an account-level cap, not a replacement.
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
 * @param {string} [options.reviewProvider] - Run the review model on a different
 *   provider than the build (KODR_REVIEW_PROVIDER). Brings its own default base
 *   URL -- the build's is not inherited.
 * @param {string} [options.reviewBaseUrl] - Run the review model against a
 *   different endpoint, e.g. a second LM Studio instance (KODR_REVIEW_BASE_URL)
 * @param {boolean} [options.reviewSwap] - Load/unload models around the review
 *   pass (default true, KODR_REVIEW_SWAP=0). Turn off alongside a review
 *   endpoint so both models stay resident; see specs/review.yaml.
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
 * @param {number} [options.instructionsSizeCap] - Size cap for KODR.md/AGENTS.md in
 *   characters, past which a notice (not truncation) is printed (default 8000 —
 *   KODR_INSTRUCTIONS_SIZE_CAP)
 * @param {boolean} [options.debug] - Write every model request's raw request/response
 *   to a JSONL sidecar next to the run transcript (also KODR_DEBUG). Off by default;
 *   see specs/debug-log.yaml.
 * @param {boolean} [options.approveCommands] - Require confirm() approval before each
 *   run_command tool call (see specs/tui.yaml). Off by default.
 * @param {function} [options.confirm] - (call) => Promise<{ approved }>; the approval
 *   channel used when approveCommands is on (the TUI supplies this)
 * @param {AbortSignal} [options.signal] - Cancellation signal (see specs/cancel.yaml).
 *   When it fires, the in-flight model request's socket is destroyed and the run
 *   stops with stoppedReason "cancelled" — the CLI wires it to SIGINT, the ACP
 *   front-end to session/cancel.
 * @param {import('./tools/backend.mjs').ToolBackend} [options.backend] - Filesystem/exec
 *   backend for the file and command tools (see specs/acp.yaml). Defaults to the
 *   local, in-process backend; the ACP front-end injects one that delegates to the
 *   editor's fs/* and terminal/* when the client advertises those capabilities.
 * @returns {Promise<RunResult>}
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
  // Resolved once and threaded into every phase that can spend money, so the
  // ceiling bounds the run rather than each phase separately.
  const costCeilingUsd = maxCostUsd(options.maxCostUsd);
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
      // A hard per-request ceiling; the run budget (maxRunMs) still shortens a
      // near-deadline request via the per-call timeoutMs the loop passes.
      timeout: resolveRequestTimeoutMs(options.requestTimeoutMs),
      maxRetries: modelMaxRetries(options.maxRetries),
      reasoning: options.reasoning,
      noZdr: options.noZdr,
      allowDataCollection: options.allowDataCollection,
      providerOrder: options.providerOrder,
      cache: options.cache,
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
    // Skipped when the swap is off: with the reviewer on its own endpoint the
    // build model never left, and reloading it every run is exactly the cost
    // --no-review-swap exists to remove.
    if (
      options.reviewModel &&
      reviewSwapEnabled(options.reviewSwap) &&
      client.capabilities.modelLifecycle
    ) {
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
    ...reviewMetadata(options),
    testCommand: testCommand || null,
    maxHealTurns,
    maxRunMs,
    maxCostUsd: costCeilingUsd,
    maxToolTurns,
    envPassthrough,
    contextWindow,
    startedAt: startedAt.toISOString(),
  };
  // Discovered once and shared: the registry needs to know whether to offer
  // the load_skill tool at all, and the system prompt lists the same set --
  // two independent discoveries could disagree if skills changed on disk in
  // between, offering a tool for a listing the model never saw (or vice
  // versa).
  const skills = await discoverSkills(cwd);
  const tools = createToolRegistry(cwd, {
    envPassthrough,
    startedAt,
    maxRunMs,
    skills: skills.length > 0,
    vision: options.vision,
    initialFilesChanged: priorFilesChanged,
    backend: options.backend,
  });
  const commandEnv = buildEnv(envPassthrough);
  // Read once and pass the same content to both buildSystemPrompt and the
  // size-cap check below, rather than each reading MEMORY.md separately --
  // two independent reads could otherwise observe different content if a
  // concurrent process appended to it in between.
  const memoryContent = await readMemory(cwd);
  const instructionsContent = await readInstructions(cwd);
  const systemPrompt = await buildSystemPrompt(cwd, {
    memory: memoryContent,
    skills,
    instructions: instructionsContent,
  });

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

  // Same signal for the human-authored file: it goes into every prompt the
  // same way MEMORY.md does and could grow just as silently.
  const instructionsNotice = instructionsSizeNotice(
    instructionsContent,
    instructionsSizeCap(options.instructionsSizeCap),
  );
  if (instructionsNotice) {
    reporter.notice(instructionsNotice);
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
      signal: options.signal,
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
      maxRepeatToolErrors: options.maxRepeatToolErrors,
      contextWindow,
      toolHooks: toolHookSets,
      cwd,
      commandEnv,
      heartbeatMs,
      onHeartbeat: onModelHeartbeat,
      onDebug: onModelDebug,
      approveCommands: options.approveCommands,
      confirm: options.confirm,
      signal: options.signal,
      maxCostUsd: costCeilingUsd,
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
      // The tool schemas the model actually saw this run, so the saved
      // transcript is self-describing: reading a run back shouldn't require
      // re-deriving what tools were offered (or turning on --debug) to explain
      // a call that failed on its arguments.
      toolDefinitions: tools.definitions(),
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

      // Heal if a blocking hook failed. The cancel check is its own condition
      // rather than a stoppedReason read: the build completed, so stoppedReason
      // is "complete" even when the operator aborted during the verify command
      // that just failed. Heal's own tool loop would stop early, but entering
      // heal at all re-runs that same command.
      if (
        hookResult.results.length > 0 &&
        !hookResult.passed &&
        !isRunBudgetExceeded(startedAt, maxRunMs) &&
        !isCostBudgetExceeded(totalUsage.cost, costCeilingUsd) &&
        !runCancelled(options.signal, stoppedReason)
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
          maxRepeatToolErrors: options.maxRepeatToolErrors,
          contextWindow,
          toolHooks: toolHookSets,
          cwd,
          commandEnv,
          heartbeatMs,
          onHeartbeat: onModelHeartbeat,
          onDebug: onModelDebug,
          approveCommands: options.approveCommands,
          confirm: options.confirm,
          signal: options.signal,
          maxCostUsd: costCeilingUsd,
          spentUsd: totalUsage.cost,
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
    // Re-read at each gate rather than computed once: the signal can fire
    // between them (during the review pass, say), and each phase below opens
    // model calls of its own.
    const cancelled = () => runCancelled(options.signal, result.stoppedReason);
    // Re-read at each gate for the same reason: the phases below add to
    // result.usage as they go, so the run can cross its ceiling between them.
    const outOfMoney = () =>
      isCostBudgetExceeded(result.usage?.cost || 0, costCeilingUsd);

    // Review pass: a fresh tool-loop conversation over what the build phase
    // changed, on the review model if one's configured. Never lets a review
    // failure overwrite an otherwise-successful build result -- it's an
    // added opinion, not part of the outcome the run is judged on.
    if (options.reviewModel) {
      if (cancelled()) {
        // Checked before the stoppedReason branch below: a cancel during
        // verify leaves stoppedReason "complete", and the review pass is the
        // most expensive post-build step there is (a model swap plus a whole
        // tool loop -- one dogfooded reviewer spent 1,234 seconds on a single
        // pass). Starting that after Ctrl-C is the opposite of cancelling.
        result.review = reviewSkippedForCancel();
      } else if (outOfMoney()) {
        // Checked before the model swap, not left to the review's own tool
        // loop: the swap unloads and reloads models through `lms` before a
        // single token is spent, so a review that could only stop on its first
        // turn would still pay for the swap first.
        result.review = reviewSkippedForCostBudget(costCeilingUsd);
      } else if (result.stoppedReason === 'complete') {
        reporter.phase('review');
        result.review = await runReviewPass({
          cwd,
          client,
          reviewModel: options.reviewModel,
          reviewContextWindow: options.reviewContextWindow,
          reviewProvider: options.reviewProvider,
          reviewBaseUrl: options.reviewBaseUrl,
          reviewSwap: options.reviewSwap,
          buildProvider: options.provider,
          buildBaseUrl: options.baseUrl,
          timeout: resolveRequestTimeoutMs(options.requestTimeoutMs),
          maxRetries: options.maxRetries,
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
          signal: options.signal,
          maxCostUsd: costCeilingUsd,
          spentUsd: result.usage?.cost || 0,
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
      } else {
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
    }

    // End-of-run retrospective: never writes to MEMORY.md without a human
    // decision in the loop (see specs/memory.yaml). Off by default. Unlike
    // incident telemetry, noSave only skips the unattended proposal-file
    // write (runMemoryRetrospective handles that internally) rather than
    // the whole feature -- --memory-auto-apply writes directly to
    // MEMORY.md at the workspace root, unrelated to runsDir hygiene, and
    // must keep working under --no-save.
    if (isMemoryEnabled(options.memory) && cancelled()) {
      // The bug this guards: the retrospective gates on isMemoryEnabled and a
      // non-zero tool-turn count, never on how the run ended -- so a run the
      // operator just aborted went straight on to open a brand-new model call.
      // Recorded rather than left undefined, so --json can tell "memory off"
      // apart from "memory on, but the run was cancelled first".
      result.memory = memorySkippedForCancel();
    } else if (isMemoryEnabled(options.memory) && outOfMoney()) {
      // The retrospective is the last thing a run does and the easiest to go
      // without: a run that has spent its budget should not buy one more
      // model call to reflect on how it went.
      result.memory = memorySkippedForCostBudget(costCeilingUsd);
    } else if (isMemoryEnabled(options.memory)) {
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
          signal: options.signal,
        });
      } catch (err) {
        result.memory = { proposed: false, error: err.message };
      }

      if (result.memory.cancelled) {
        reporter.notice('memory retrospective cancelled');
      } else if (result.memory.error) {
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
 * @param {Array} params.hooks
 * @param {string} params.cwd
 * @param {Record<string, string>} params.commandEnv
 * @param {Array} params.messages
 * @param {Date} params.startedAt
 * @param {number} params.maxRunMs
 * @param {import('./reporter.mjs').Reporter} params.reporter
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
 * @param {Array} params.hooks
 * @param {string} params.cwd
 * @param {Record<string, string>} params.commandEnv
 * @param {import('./reporter.mjs').Reporter} params.reporter
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
    toolDefinitions: tools.definitions(),
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

export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Per-request timeout ceiling, independent of the whole-run budget (maxRunMs):
 * bounds any single model request so a stalled local backend fails that request
 * instead of hanging for the full default. The run budget can only make a given
 * request's timeout shorter, never longer. Resolved from an explicit option,
 * then KODR_REQUEST_TIMEOUT_MS, then the default (10 minutes). Must be positive
 * -- there is no "disable" (a request with no timeout could hang forever); set
 * a large value to effectively lift the cap.
 * @param {number} [option]
 * @returns {number}
 */
export function resolveRequestTimeoutMs(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_REQUEST_TIMEOUT_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
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
 * @param {import('./provider.mjs').Provider} params.client
 * @param {string} params.modelId
 * @param {Array} params.messages
 * @param {object} params.metadata
 * @param {import('./reporter.mjs').Reporter} params.reporter
 * @param {Date} params.startedAt
 * @param {string} [params.runsDir]
 * @param {boolean} [params.noSave]
 * @param {number} [params.maxRunMs]
 * @param {number} [params.heartbeatMs]
 * @param {function} [params.onHeartbeat]
 * @param {function} [params.onDebug]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<object>} Run result
 */
async function runManualCompaction(params) {
  const { client, modelId, messages, metadata, reporter, startedAt } = params;
  const { runsDir, noSave, maxRunMs = 0, heartbeatMs, onHeartbeat } = params;
  const { onDebug, signal } = params;

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
    signal,
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
 * The result.review value for a run cancelled before the review pass could
 * start. Distinct from reviewSkippedForIncompleteBuild because a cancel can
 * land *after* a complete build (during verify), where stoppedReason alone
 * would read as a healthy run.
 * @returns {{ skipped: true, reason: string }}
 */
export function reviewSkippedForCancel() {
  return { skipped: true, reason: 'run cancelled' };
}

/**
 * The result.memory value for a run cancelled before the retrospective could
 * start.
 * @returns {{ proposed: false, cancelled: true, reason: string }}
 */
export function memorySkippedForCancel() {
  return { proposed: false, cancelled: true, reason: 'run cancelled' };
}

/**
 * The result.review value for a run that spent its cost ceiling before the
 * review pass. A skip, never a verdict -- running out of money says nothing
 * about the change, and a gate must not read it as a fail.
 * @param {number} ceilingUsd
 * @returns {{ skipped: true, reason: string }}
 */
export function reviewSkippedForCostBudget(ceilingUsd) {
  return {
    skipped: true,
    reason: `run cost budget spent (maxCostUsd: ${ceilingUsd})`,
  };
}

/**
 * The result.memory value for a run that spent its cost ceiling before the
 * retrospective.
 * @param {number} ceilingUsd
 * @returns {{ proposed: false, reason: string }}
 */
export function memorySkippedForCostBudget(ceilingUsd) {
  return {
    proposed: false,
    reason: `run cost budget spent (maxCostUsd: ${ceilingUsd})`,
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
 * @param {string} params.cwd
 * @param {import('./provider.mjs').Provider} params.client
 * @param {string} params.reviewModel
 * @param {number} [params.reviewContextWindow]
 * @param {number} params.buildContextWindow
 * @param {string[]} params.filesChanged
 * @param {Date} params.startedAt
 * @param {number} params.maxRunMs
 * @param {number} [params.heartbeatMs]
 * @param {function} [params.onHeartbeat]
 * @param {function} [params.onDebug]
 * @param {string[]} [params.envPassthrough]
 * @param {number} [params.minToolCalls]
 * @param {number} [params.maxToolTurns]
 * @param {AbortSignal} [params.signal] - Cancellation signal, forwarded to the
 *   review's own tool loop (see specs/cancel.yaml)
 * @param {number} [params.maxCostUsd] - Run spend ceiling in USD (0 disables),
 *   forwarded to the review's own tool loop
 * @param {number} [params.spentUsd] - What the run cost before the review
 * @param {import('./reporter.mjs').Reporter} [params.reporter]
 * @param {string} [params.reviewProvider]
 * @param {string} [params.reviewBaseUrl]
 * @param {boolean} [params.reviewSwap]
 * @param {string} [params.buildProvider]
 * @param {string} [params.buildBaseUrl]
 * @param {number} [params.timeout]
 * @param {number} [params.maxRetries]
 * @param {function} [params.createProviderFn]
 * @param {function} [params.ensureModelLoadedFn]
 * @param {function} [params.runReviewFn]
 */
/**
 * The client the review pass talks to. Reuses the build's unless a review
 * provider or base URL was configured, in which case the reviewer gets its
 * own -- which is what lets both models stay resident instead of trading
 * places on one backend twice per attempt.
 *
 * Returns { error } rather than throwing, so a misconfigured endpoint skips
 * the review instead of failing a build that already succeeded.
 * @param {object} params
 * @param {import('./provider.mjs').Provider} params.client
 * @param {string} [params.reviewProvider]
 * @param {string} [params.reviewBaseUrl]
 * @param {string} [params.buildProvider]
 * @param {string} [params.buildBaseUrl]
 * @param {string} [params.reviewModel]
 * @param {number} [params.timeout]
 * @param {number} [params.maxRetries]
 * @param {function} [params.createProviderFn]
 * @returns {{ client?: import('./provider.mjs').Provider, error?: string }}
 */
function resolveReviewClient(params) {
  const { client } = params;
  const reviewProvider = reviewProviderName(params.reviewProvider);
  const reviewBaseUrl = reviewBaseUrlFor(params.reviewBaseUrl);
  if (!reviewProvider && !reviewBaseUrl) {
    return { client };
  }
  const endpoint = reviewEndpoint({
    reviewProvider,
    reviewBaseUrl,
    buildProvider: params.buildProvider,
    buildBaseUrl: params.buildBaseUrl,
  });
  try {
    const createProviderFn = params.createProviderFn || createProvider;
    return {
      client: createProviderFn({
        provider: endpoint.provider,
        baseUrl: endpoint.baseUrl,
        model: params.reviewModel,
        timeout: params.timeout,
        maxRetries: params.maxRetries,
      }),
    };
  } catch (err) {
    return { error: `review client: ${err.message}` };
  }
}

export async function runReviewPass(params) {
  const {
    cwd,
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
    signal,
    maxCostUsd: costCeilingUsd,
    spentUsd,
    reporter = createNullReporter(),
    ensureModelLoadedFn = ensureModelLoaded,
    runReviewFn = runReview,
  } = params;
  const swap = reviewSwapEnabled(params.reviewSwap);
  // reviewContextWindow is explicitly "unset" only when it's null/undefined
  // -- 0 is a legitimate value (this repo's own "0 disables" convention),
  // and `|| buildContextWindow` would otherwise silently override it.
  const contextWindow = Number.isInteger(reviewContextWindow)
    ? reviewContextWindow
    : buildContextWindow;

  try {
    const resolved = resolveReviewClient(params);
    if (resolved.error) {
      reporter.notice(`review skipped: ${resolved.error}`);
      return { skipped: true, error: resolved.error };
    }
    const reviewClient = resolved.client;

    // Three ways this load is unnecessary. The provider may have no
    // model-lifecycle concept at all (OpenRouter: the model is just a
    // per-request field). The reviewer may live on its own endpoint, where
    // both models stay resident and swapping would unload the wrong backend's
    // model. Or the operator may have said not to (--no-review-swap).
    if (swap && reviewClient.capabilities.modelLifecycle) {
      // Bracketed by cancel checks because the swap itself is not
      // signal-aware: it shells out to `lms` to unload and reload models, up
      // to a 2-minute default timeout, with nothing watching the signal. A
      // cancel landing here would otherwise wait out that whole sequence
      // before the (signal-aware) tool loop below could notice it.
      if (signal?.aborted) {
        return reviewSkippedForCancel();
      }
      const loadResult = await ensureModelLoadedFn({
        model: reviewModel,
        contextWindow,
      });
      if (loadResult.error) {
        reporter.notice(`review skipped: ${loadResult.error}`);
        return { skipped: true, error: loadResult.error };
      }
      if (signal?.aborted) {
        return reviewSkippedForCancel();
      }
    }

    const reviewResult = await runReviewFn({
      client: reviewClient,
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
      signal,
      // The entry gate above only catches a ceiling already crossed *before*
      // the review. Without these the review's own tool loop runs unbounded,
      // which is the phase most able to spend: a whole second tool loop, and
      // one dogfooded reviewer burned 44,725 completion tokens on a single
      // pass.
      maxCostUsd: costCeilingUsd,
      spentUsd,
    });

    if (!reviewResult.skipped) {
      reporter.notice(reviewNotice(reviewResult));
    }
    return reviewResult;
  } catch (err) {
    reporter.notice(`review failed: ${err.message}`);
    return { skipped: true, error: err.message };
  }
}

/**
 * One line naming what the reviewer decided and how much it looked at. The
 * verdict is the part an operator acts on, so it leads.
 * @param {{ verdict?: string, verdictFound?: boolean, grounded?: boolean,
 *   toolTurns?: number }} review
 * @returns {string}
 */
export function reviewNotice(review) {
  if (!review.verdictFound) {
    return 'review: FAIL (no verdict line in the reply -- treated as a fail)';
  }
  if (!review.grounded) {
    return `review: ${review.verdict.toUpperCase()} but ungrounded (no files inspected) -- treat with caution`;
  }
  return `review: ${review.verdict.toUpperCase()} (${review.toolTurns} tool calls)`;
}

/**
 * Resolve the context window for a run. Precedence: an explicit option or the
 * KODR_CONTEXT_WINDOW env var, then the model's loaded context length probed
 * from LM Studio, then the built-in default. Emits a one-line notice on startup
 * so the operator can see which window is in effect.
 * @param {object} params
 * @param {number} [params.option] - Explicit --context-window value
 * @param {import('./provider.mjs').Provider} params.client - Model client (for probing)
 * @param {string} params.modelId - Resolved model id
 * @param {import('./reporter.mjs').Reporter} [params.reporter] - Output channel for the startup notice
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
  if (stoppedReason === 'cancelled') {
    return 'cancelled';
  }
  if (stoppedReason === 'budget-exceeded') {
    return 'stopped after run budget';
  }
  if (stoppedReason === 'cost-exceeded') {
    return 'stopped: the run spent its cost budget';
  }
  if (stoppedReason === 'stuck') {
    return 'stopped: the same tool call failed repeatedly';
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
 * The reviewer's identity, for the run record's metadata. metadata.model is
 * the build model, and until this landed nothing on disk said which model
 * produced a verdict -- so a workspace that tried two reviewers (which
 * docs/usage.md tells operators to do) could not tell their verdicts apart
 * afterwards.
 *
 * All null when no review model is configured: that run reviewed nothing, and
 * naming an endpoint from KODR_REVIEW_* would record a reviewer that never
 * ran. Recorded per run rather than derived from the review result, so a run
 * whose review was skipped still says who was meant to do it.
 * @param {{ reviewModel?: string, reviewProvider?: string, reviewBaseUrl?: string }} options
 * @returns {{ reviewModel: string|null, reviewProvider: string|null, reviewBaseUrl: string|null }}
 */
export function reviewMetadata(options) {
  if (!options.reviewModel) {
    return { reviewModel: null, reviewProvider: null, reviewBaseUrl: null };
  }
  return {
    reviewModel: options.reviewModel,
    reviewProvider: reviewProviderName(options.reviewProvider),
    reviewBaseUrl: reviewBaseUrlFor(options.reviewBaseUrl),
  };
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
  const timestamp = finish.finishedAt || new Date().toISOString();
  return {
    timestamp,
    // The same instant in the machine's local time zone, so a saved run reads
    // at a glance without doing UTC-to-local math in your head.
    timestampLocal: toLocalIso(new Date(timestamp)),
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
    // The whole ReviewResult, findings included. runReview builds its own
    // message array that never joins result.messages, so if the record
    // doesn't hold the findings they exist nowhere on disk -- and once a
    // verdict can block a commit, "why did the reviewer fail this?" has to be
    // answerable after the terminal scrollback is gone.
    review: result.review ?? null,
    noOpCompletion: result.noOpCompletion ?? false,
    healed: result.healed ?? null,
    healTurns: result.healTurns ?? null,
    // The tool schemas offered to the model, so the log is self-describing
    // (null on paths that offer no tools, e.g. the "/compact" management run).
    tools: result.toolDefinitions ?? null,
    messages: result.messages,
  };
}

/**
 * Format a Date as an ISO-8601 string in the machine's local time zone, with
 * its UTC offset -- e.g. "2026-07-14T04:20:31.547+02:00". The same instant as
 * the record's UTC `timestamp`, just in the operator's own zone. Parses back to
 * the same instant via new Date(), so the two stay a matched pair.
 * @param {Date} date
 * @returns {string}
 */
export function toLocalIso(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  // getTimezoneOffset is minutes behind UTC (positive west), so negate it to
  // get the conventional "minutes east of UTC" the ISO offset expresses.
  const offsetMinutes = -date.getTimezoneOffset();
  let sign = '+';
  if (offsetMinutes < 0) {
    sign = '-';
  }
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${ymd}T${hms}${offset}`;
}
