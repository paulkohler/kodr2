/**
 * CLI argument parsing and dispatch.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_COMMIT_TIMEOUT_MS } from './commit.mjs';
import { runDoctorChecks } from './doctor.mjs';
import { parseEnvNames } from './env.mjs';
import {
  formatDoctorReport,
  formatModelsList,
  formatSimpleModelsList,
  formatStats,
} from './format.mjs';
import {
  DEFAULT_MAX_ATTEMPTS,
  evaluateGoal,
  runGoal,
  summarizeGoalResult,
} from './goal.mjs';
import {
  DEFAULT_HEARTBEAT_MS,
  resolveRequestTimeoutMs,
  resolveRunsDir,
  run,
} from './harness.mjs';
import { DEFAULT_INCIDENT_HEARTBEAT_MS } from './incident.mjs';
import { DEFAULT_MAX_RETRIES } from './model.mjs';
import { createProvider, resolveProviderName } from './provider.mjs';
import {
  createJsonReporter,
  createNullReporter,
  createTerminalReporter,
} from './reporter.mjs';
import {
  DEFAULT_MIN_REVIEW_TOOL_CALLS,
  DEFAULT_REVIEW_MAX_TOOL_TURNS,
} from './review.mjs';
import { computeStats, loadRunRecords } from './stats.mjs';
import { MAX_TOOL_TURNS } from './tool-loop.mjs';

/**
 * @typedef {object} CliArgs
 * @property {string|null} command
 * @property {string|null} prompt
 * @property {string|null} cwd
 * @property {string|null} provider
 * @property {string|null} baseUrl
 * @property {string|null} model
 * @property {boolean|null} reasoning
 * @property {boolean} vision
 * @property {boolean|null} openrouterNoZdr
 * @property {boolean|null} openrouterAllowDataCollection
 * @property {string[]} openrouterProviderOnly
 * @property {string|null} test
 * @property {number} healTurns
 * @property {number} maxRunMs
 * @property {number} maxToolTurns
 * @property {number|null} maxRepeatToolErrors
 * @property {number|null} requestTimeoutMs
 * @property {number} maxAttempts
 * @property {number} heartbeatMs
 * @property {number} incidentHeartbeatMs
 * @property {number} modelRetries
 * @property {number|null} contextWindow
 * @property {string|null} reviewModel
 * @property {number|null} reviewContextWindow
 * @property {number} reviewMinToolCalls
 * @property {number} reviewMaxToolTurns
 * @property {boolean} quiet
 * @property {string[]} env
 * @property {string|null} continue
 * @property {string|null} runsDir
 * @property {boolean} noSave
 * @property {boolean} rawThenFixCommits
 * @property {boolean} memory
 * @property {boolean} memoryAutoApply
 * @property {boolean} debug
 * @property {number} commitTimeoutMs
 * @property {boolean} json
 * @property {boolean} events
 * @property {boolean} tui
 * @property {boolean} approveCommands
 * @property {boolean} noFail
 * @property {boolean} help
 * @property {boolean} version
 */

/** @typedef {import('./harness.mjs').RunResult} RunResult */

/**
 * Parse CLI arguments and run.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Promise<void>}
 */
export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  if (args.version) {
    await printVersion();
    return;
  }

  if (args.command === 'models') {
    await printModels(args);
    return;
  }

  if (args.command === 'doctor') {
    await printDoctor(args);
    return;
  }

  if (args.command === 'stats') {
    await printStats(args);
    return;
  }

  if (args.command === 'replay') {
    await runReplay(args);
    return;
  }

  if (args.command === 'goal') {
    await runGoalCommand(args);
    return;
  }

  if (args.command === 'acp') {
    await runAcpCommand(args);
    return;
  }

  if (tuiRequested(args)) {
    const tuiError = validateTui(args);
    if (tuiError) {
      process.stderr.write(`${tuiError}\n`);
      process.exitCode = 1;
      return;
    }
  } else if (!args.prompt) {
    process.stderr.write('Usage: kodr run "your prompt here"\n');
    process.stderr.write('Run `kodr --help` for more options.\n');
    process.exitCode = 1;
    return;
  }

  if (!Number.isInteger(args.healTurns) || args.healTurns < 0) {
    process.stderr.write('--heal-turns must be a non-negative integer.\n');
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.maxRunMs) || args.maxRunMs < 0) {
    process.stderr.write('--max-run-ms must be a non-negative integer.\n');
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.maxToolTurns) || args.maxToolTurns < 1) {
    process.stderr.write('--max-tool-turns must be a positive integer.\n');
    process.exitCode = 1;
    return;
  }
  if (
    args.maxRepeatToolErrors !== null &&
    (!Number.isInteger(args.maxRepeatToolErrors) ||
      args.maxRepeatToolErrors < 0)
  ) {
    process.stderr.write(
      '--max-repeat-tool-errors must be a non-negative integer.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (
    args.requestTimeoutMs !== null &&
    (!Number.isInteger(args.requestTimeoutMs) || args.requestTimeoutMs < 1)
  ) {
    process.stderr.write('--request-timeout-ms must be a positive integer.\n');
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.heartbeatMs) || args.heartbeatMs < 0) {
    process.stderr.write('--heartbeat-ms must be a non-negative integer.\n');
    process.exitCode = 1;
    return;
  }
  if (
    !Number.isInteger(args.incidentHeartbeatMs) ||
    args.incidentHeartbeatMs < 0
  ) {
    process.stderr.write(
      '--incident-heartbeat-ms must be a non-negative integer.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.commitTimeoutMs) || args.commitTimeoutMs < 0) {
    process.stderr.write(
      '--commit-timeout-ms must be a non-negative integer.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.modelRetries) || args.modelRetries < 0) {
    process.stderr.write('--model-retries must be a non-negative integer.\n');
    process.exitCode = 1;
    return;
  }
  if (
    args.contextWindow !== null &&
    (!Number.isInteger(args.contextWindow) || args.contextWindow < 0)
  ) {
    process.stderr.write('--context-window must be a non-negative integer.\n');
    process.exitCode = 1;
    return;
  }
  if (
    args.reviewContextWindow !== null &&
    (!Number.isInteger(args.reviewContextWindow) ||
      args.reviewContextWindow < 0)
  ) {
    process.stderr.write(
      '--review-context-window must be a non-negative integer.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (
    !Number.isInteger(args.reviewMinToolCalls) ||
    args.reviewMinToolCalls < 0
  ) {
    process.stderr.write(
      '--review-min-tool-calls must be a non-negative integer.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (
    !Number.isInteger(args.reviewMaxToolTurns) ||
    args.reviewMaxToolTurns < 1
  ) {
    process.stderr.write(
      '--review-max-tool-turns must be a positive integer.\n',
    );
    process.exitCode = 1;
    return;
  }
  const providerName = resolveProviderName(args.provider);
  if (!['lmstudio', 'openrouter', 'ollama'].includes(providerName)) {
    process.stderr.write(
      `Unknown provider "${providerName}" -- must be one of: lmstudio, openrouter, ollama.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cwd = resolve(args.cwd || '.');
  const options = {
    cwd,
    provider: args.provider,
    baseUrl: args.baseUrl,
    model: args.model,
    reasoning: args.reasoning,
    vision: visionEnabled(args),
    noZdr: args.openrouterNoZdr,
    allowDataCollection: args.openrouterAllowDataCollection,
    providerOrder: args.openrouterProviderOnly,
    testCommand: args.test,
    maxHealTurns: args.healTurns,
    maxRunMs: args.maxRunMs,
    maxToolTurns: args.maxToolTurns,
    maxRepeatToolErrors: args.maxRepeatToolErrors,
    requestTimeoutMs: args.requestTimeoutMs,
    heartbeatMs: args.heartbeatMs,
    incidentHeartbeatMs: args.incidentHeartbeatMs,
    maxRetries: args.modelRetries,
    reviewModel: args.reviewModel,
    reviewMinToolCalls: args.reviewMinToolCalls,
    reviewMaxToolTurns: args.reviewMaxToolTurns,
    quiet: args.quiet || args.json,
    // --events streams the run as NDJSON on stdout (specs/reporter.yaml); left
    // undefined otherwise so the harness picks the terminal/null reporter.
    reporter: args.events ? createJsonReporter() : undefined,
    envPassthrough: args.env,
    runsDir: args.runsDir,
    noSave: args.noSave,
    rawThenFixCommits: args.rawThenFixCommits,
    commitTimeoutMs: args.commitTimeoutMs,
    memory: args.memory,
    memoryAutoApply: args.memoryAutoApply,
    debug: args.debug,
    approveCommands: args.approveCommands,
    // Attended: an interactive terminal where output isn't being scraped
    // (--quiet) or consumed as machine-readable (--json) -- only then does
    // prompting for a y/N confirmation make sense. Both ends of the
    // terminal matter here, not just stdout: stdin also has to be a real
    // TTY, or a y/N prompt has nothing to actually read an answer from
    // (memory.mjs's own prompt timeout is a backstop, not a substitute
    // for getting this right at the source).
    memoryAttended:
      Boolean(process.stdout.isTTY) &&
      Boolean(process.stdin.isTTY) &&
      !args.quiet &&
      !args.json,
  };
  if (args.contextWindow !== null) {
    options.contextWindow = args.contextWindow;
  }
  if (args.reviewContextWindow !== null) {
    options.reviewContextWindow = args.reviewContextWindow;
  }

  // Handle continuation
  if (args.continue) {
    const prior = await loadPriorRun(
      cwd,
      args.continue,
      resolveRunsDir(cwd, args.runsDir),
    );
    if (prior) {
      options.priorMessages = prior.messages;
      options.priorFilesChanged = prior.filesChanged || [];
    } else {
      process.stderr.write('No prior run found to continue from.\n');
      process.exitCode = 1;
      return;
    }
  }

  // Interactive TUI: a multi-turn REPL over the same harness (specs/tui.yaml).
  // It supplies its own reporter and command-approval channel, so quiet/events
  // don't apply.
  if (tuiRequested(args)) {
    const { runTui } = await import('./tui.mjs');
    options.reporter = undefined;
    options.quiet = false;
    await runTui(args.prompt || '', options);
    return;
  }

  try {
    // Ctrl-C cancels the in-flight run (specs/cancel.yaml): the first SIGINT
    // aborts the current model request and lets run() unwind to a cancelled
    // result; a second forces a hard exit if the graceful stop hangs.
    const controller = new AbortController();
    options.signal = controller.signal;
    const onSigint = createSigintCanceller(controller);
    process.on('SIGINT', onSigint);
    let result;
    try {
      result = await run(args.prompt, options);
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(summarizeResult(result))}\n`);
    }
    process.exitCode = exitCodeFor(result, args);
  } catch (err) {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ stoppedReason: 'error', error: err.message })}\n`,
      );
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    if (!noFailEnabled(args)) {
      process.exitCode = 1;
    }
  }
}

/**
 * A SIGINT handler that cancels the in-flight run gracefully on the first
 * Ctrl-C (aborting the current model request via the run's AbortController) and
 * force-quits on the second, in case the graceful unwind itself hangs. Returned
 * as a closure over a per-run controller and press counter so it is unit-
 * testable without sending real signals. `exit` is injectable for the same
 * reason (defaults to process.exit).
 * @param {AbortController} controller
 * @param {{ write: (s: string) => void }} [err] - Where notices go (default stderr)
 * @param {(code: number) => void} [exit] - Hard-exit fn (default process.exit)
 * @returns {() => void}
 */
export function createSigintCanceller(controller, err = process.stderr, exit) {
  const hardExit = exit || ((code) => process.exit(code));
  let presses = 0;
  return () => {
    presses++;
    if (presses === 1) {
      err.write('\nCancelling — press Ctrl-C again to force quit.\n');
      controller.abort();
      return;
    }
    err.write('\nForce quit.\n');
    hardExit(130);
  };
}

/**
 * Process exit code for a completed run. With --no-fail (or KODR_NO_FAIL) Kodr
 * always exits 0 — for external-verifier contexts (Terminal-Bench, arenas)
 * where the verifier is the judge and a non-zero agent exit is recorded as a
 * harness error rather than a clean reward 0.
 * @param {RunResult} result
 * @param {CliArgs} args
 * @returns {number}
 */
export function exitCodeFor(result, args) {
  if (noFailEnabled(args)) {
    return 0;
  }
  if (shouldFailProcess(result)) {
    return 1;
  }
  return 0;
}

/** @param {CliArgs} args */
function noFailEnabled(args) {
  if (args.noFail) {
    return true;
  }
  const env = process.env.KODR_NO_FAIL;
  return env === '1' || env === 'true';
}

/**
 * Whether the interactive TUI was requested (--tui or the `tui` subcommand).
 * @param {CliArgs} args
 */
export function tuiRequested(args) {
  return Boolean(args.tui) || args.command === 'tui';
}

/**
 * Validate a --tui invocation. Returns an error string, or null when the
 * request is valid. The TUI owns the terminal, so it needs a real interactive
 * TTY on both ends and is incompatible with the output modes that scrape or
 * silence stdout/stderr.
 * @param {CliArgs} args
 * @returns {string|null}
 */
export function validateTui(args) {
  if (args.json || args.quiet || args.events) {
    return '--tui cannot be combined with --json, --quiet, or --events.';
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return '--tui requires an interactive terminal (stdin and stdout must be a TTY).';
  }
  return null;
}

/**
 * Whether the view_image tool should be offered, from --vision or KODR_VISION.
 * Off by default; vision can't be auto-detected (LM Studio reports only
 * tool_use even for a vision model), so the operator enables it explicitly.
 * @param {CliArgs} args
 * @returns {boolean}
 */
export function visionEnabled(args) {
  if (args.vision) {
    return true;
  }
  const env = process.env.KODR_VISION;
  return env === '1' || env === 'true';
}

/**
 * A compact, machine-readable summary of a run for --json mode. Lets an external
 * harness/adapter read what Kodr did (outcome and cost) without scraping output.
 * @param {RunResult} result
 * @returns {object}
 */
export function summarizeResult(result) {
  return {
    stoppedReason: result.stoppedReason,
    completed: result.stoppedReason === 'complete',
    toolTurns: result.toolTurns ?? 0,
    usage: result.usage ?? { prompt: 0, completion: 0, cost: 0 },
    compactions: result.compactions ?? 0,
    retries: result.retries ?? 0,
    healed: result.healed ?? null,
    healTurns: result.healTurns ?? null,
    verified: result.verification?.passed ?? null,
    noOpCompletion: result.noOpCompletion ?? false,
    filesChanged: result.filesChanged ?? [],
    packageCommands: result.packageCommands ?? [],
    response: result.response ?? '',
    error: result.error?.message ?? null,
    commits: result.commits ?? null,
    review: result.review ?? null,
  };
}

/** @param {RunResult} result */
export function shouldFailProcess(result) {
  if (result.stoppedReason && result.stoppedReason !== 'complete') {
    return true;
  }
  if (result.verification && result.verification.passed === false) {
    return true;
  }
  return false;
}

/**
 * Parse argv into structured options.
 * @param {string[]} argv
 * @returns {CliArgs}
 */
export function parseArgs(argv) {
  const args = {
    command: null,
    prompt: null,
    cwd: null,
    provider: null,
    baseUrl: null,
    model: null,
    // null (not false) so the KODR_REASONING/KODR_OPENROUTER_NO_ZDR/
    // KODR_OPENROUTER_ALLOW_DATA_COLLECTION env vars still take effect when
    // the corresponding flag isn't passed -- reasoningEnabled/zdrEnabled/
    // dataCollectionDenied treat an explicit false as an override that
    // always wins over the env var, so defaulting to false here would make
    // those env vars permanently unreachable through the CLI (see
    // specs/provider.yaml).
    reasoning: null,
    vision: false,
    openrouterNoZdr: null,
    openrouterAllowDataCollection: null,
    openrouterProviderOnly: [],
    test: null,
    healTurns: 3,
    maxRunMs: 0,
    maxToolTurns: MAX_TOOL_TURNS,
    // null (not a number) so the KODR_MAX_REPEAT_TOOL_ERRORS env var still
    // reaches the resolver when the flag isn't passed -- a numeric default here
    // would always win over it (see maxRepeatToolErrors in tool-loop.mjs).
    maxRepeatToolErrors: null,
    // null so KODR_REQUEST_TIMEOUT_MS still reaches the resolver when the flag
    // isn't passed (same reasoning as maxRepeatToolErrors above).
    requestTimeoutMs: null,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    incidentHeartbeatMs: DEFAULT_INCIDENT_HEARTBEAT_MS,
    modelRetries: DEFAULT_MAX_RETRIES,
    contextWindow: null,
    reviewModel: null,
    reviewContextWindow: null,
    reviewMinToolCalls: DEFAULT_MIN_REVIEW_TOOL_CALLS,
    reviewMaxToolTurns: DEFAULT_REVIEW_MAX_TOOL_TURNS,
    quiet: false,
    env: [],
    continue: null,
    runsDir: null,
    noSave: false,
    rawThenFixCommits: false,
    memory: false,
    memoryAutoApply: false,
    debug: false,
    commitTimeoutMs: DEFAULT_COMMIT_TIMEOUT_MS,
    json: false,
    events: false,
    tui: false,
    approveCommands: false,
    noFail: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      i++;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      args.version = true;
      i++;
      continue;
    }
    if (arg === '--quiet' || arg === '-q') {
      args.quiet = true;
      i++;
      continue;
    }
    if (arg === '--cwd' && argv[i + 1]) {
      args.cwd = argv[++i];
      i++;
      continue;
    }
    if (arg === '--provider' && argv[i + 1]) {
      args.provider = argv[++i];
      i++;
      continue;
    }
    if (arg === '--base-url' && argv[i + 1]) {
      args.baseUrl = argv[++i];
      i++;
      continue;
    }
    if (arg === '--model' && argv[i + 1]) {
      args.model = argv[++i];
      i++;
      continue;
    }
    if (arg === '--reasoning') {
      args.reasoning = true;
      i++;
      continue;
    }
    if (arg === '--vision') {
      args.vision = true;
      i++;
      continue;
    }
    if (arg === '--openrouter-no-zdr') {
      args.openrouterNoZdr = true;
      i++;
      continue;
    }
    if (arg === '--openrouter-allow-data-collection') {
      args.openrouterAllowDataCollection = true;
      i++;
      continue;
    }
    if (arg === '--openrouter-provider-only' && argv[i + 1]) {
      args.openrouterProviderOnly = parseEnvNames(argv[++i]);
      i++;
      continue;
    }
    if (arg === '--test' && argv[i + 1]) {
      args.test = argv[++i];
      i++;
      continue;
    }
    if ((arg === '--prompt' || arg === '-p') && argv[i + 1]) {
      args.prompt = argv[++i];
      i++;
      continue;
    }
    if (arg === '--heal-turns' && argv[i + 1]) {
      args.healTurns = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--max-run-ms' && argv[i + 1]) {
      args.maxRunMs = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--max-tool-turns' && argv[i + 1]) {
      args.maxToolTurns = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--max-attempts' && argv[i + 1]) {
      args.maxAttempts = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--max-repeat-tool-errors' && argv[i + 1]) {
      args.maxRepeatToolErrors = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--request-timeout-ms' && argv[i + 1]) {
      args.requestTimeoutMs = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--heartbeat-ms' && argv[i + 1]) {
      args.heartbeatMs = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--incident-heartbeat-ms' && argv[i + 1]) {
      args.incidentHeartbeatMs = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--model-retries' && argv[i + 1]) {
      args.modelRetries = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--context-window' && argv[i + 1]) {
      args.contextWindow = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--review-model' && argv[i + 1]) {
      args.reviewModel = argv[++i];
      i++;
      continue;
    }
    if (arg === '--review-context-window' && argv[i + 1]) {
      args.reviewContextWindow = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--review-min-tool-calls' && argv[i + 1]) {
      args.reviewMinToolCalls = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--review-max-tool-turns' && argv[i + 1]) {
      args.reviewMaxToolTurns = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--env' && argv[i + 1]) {
      args.env = parseEnvNames(argv[++i]);
      i++;
      continue;
    }
    if (arg === '--continue' && argv[i + 1]) {
      args.continue = argv[++i];
      i++;
      continue;
    }
    if (arg === '--runs-dir' && argv[i + 1]) {
      args.runsDir = argv[++i];
      i++;
      continue;
    }
    if (arg === '--no-save') {
      args.noSave = true;
      i++;
      continue;
    }
    if (arg === '--raw-then-fix-commits') {
      args.rawThenFixCommits = true;
      i++;
      continue;
    }
    if (arg === '--commit-timeout-ms' && argv[i + 1]) {
      args.commitTimeoutMs = parseInt(argv[++i], 10);
      i++;
      continue;
    }
    if (arg === '--memory') {
      args.memory = true;
      i++;
      continue;
    }
    if (arg === '--memory-auto-apply') {
      args.memoryAutoApply = true;
      i++;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      i++;
      continue;
    }
    if (arg === '--events') {
      args.events = true;
      i++;
      continue;
    }
    if (arg === '--tui') {
      args.tui = true;
      i++;
      continue;
    }
    if (arg === '--approve-commands') {
      args.approveCommands = true;
      i++;
      continue;
    }
    if (arg === '--no-fail') {
      args.noFail = true;
      i++;
      continue;
    }
    if (arg === '--debug') {
      args.debug = true;
      i++;
      continue;
    }

    // Positional: first is command, second is prompt
    if (!args.command) {
      args.command = arg;
    } else if (!args.prompt) {
      args.prompt = arg;
    }

    i++;
  }

  // `kodr run "prompt"` — command is "run", prompt is the next arg
  // `kodr run -p "prompt"` — compatibility alias for old operator scripts
  // `kodr "prompt"` — no command, prompt is the first arg
  if (args.command === 'run') {
    // prompt is already set from positional
  } else if (args.command === 'models') {
    // standalone subcommand — lists models, takes no prompt
  } else if (args.command === 'doctor') {
    // standalone subcommand — preflight checks, takes no prompt
  } else if (args.command === 'stats') {
    // standalone subcommand — aggregates run records, takes no prompt
  } else if (args.command === 'replay') {
    // `kodr replay <last|path>` — the ref lands in args.prompt via the
    // generic "second positional" capture above; replay reads it as a ref,
    // not a task prompt, and re-runs the referenced record's own prompt.
  } else if (args.command === 'goal') {
    // `kodr goal "<goal>"` — the goal text lands in args.prompt via the second
    // positional; goal reads it as the success criterion the judge assesses,
    // not a one-shot task prompt. Don't shorthand a bare `kodr goal` into a run.
  } else if (args.command === 'tui') {
    // `kodr tui ["prompt"]` — launch the interactive TUI; the prompt is
    // optional (typed into the input box otherwise), so don't shorthand a
    // bare `kodr tui` into a run with prompt "tui".
  } else if (args.command === 'acp') {
    // `kodr acp` — launch the ACP front-end over stdio (specs/acp.yaml). Takes
    // no prompt (the client sends prompts as session/prompt requests), so don't
    // shorthand a bare `kodr acp` into a run with prompt "acp".
  } else if (args.command && !args.prompt) {
    // Treat the command as the prompt (shorthand)
    args.prompt = args.command;
    args.command = 'run';
  }

  return args;
}

function printHelp() {
  const help = `
kodr — a one-shot coding harness for LM Studio

Usage:
  kodr run "your prompt"          Run a coding task
  kodr "your prompt"              Shorthand for 'kodr run'
  kodr models                     List LM Studio models and their context windows
  kodr doctor                     Preflight checks: LM Studio, a loaded model, git, Node.js version
  kodr stats                      Aggregate rates (heal, retry, compaction, verify) across saved runs
  kodr replay <last|path>         Re-run a saved run's original prompt fresh, to check reproducibility
  kodr goal "<goal>"              Iterate run() until a model judge says the goal is met (specs/goal.yaml)
  kodr acp                        Serve Kodr as an ACP agent over stdio for an editor (specs/acp.yaml)

Options:
  --cwd <path>                    Workspace directory (default: .)
  --provider <name>                lmstudio, openrouter, or ollama (or KODR_PROVIDER; default: lmstudio)
  --base-url <url>                Provider API URL (default: http://localhost:1234/v1 for
                                  lmstudio, https://openrouter.ai/api/v1 for openrouter,
                                  http://localhost:11434/v1 for ollama -- pass
                                  https://ollama.com/v1 for Ollama's hosted API instead of a
                                  local install, with OLLAMA_API_KEY set)
  --model <id>                    Model identifier (or KODR_MODEL; auto-detected from LM Studio
                                  if omitted -- required with --provider openrouter)
  --reasoning                     Request reasoning tokens (or KODR_REASONING). Only
                                  --provider openrouter supports this today -- errors otherwise.
                                  See specs/provider.yaml.
  --vision                        Offer the view_image tool so a vision-capable model can see
                                  image files (or KODR_VISION). Off by default; enable it when
                                  pointing Kodr at a vision model. See specs/vision.yaml.
  --openrouter-no-zdr             Disable Zero Data Retention routing (or KODR_OPENROUTER_NO_ZDR).
                                  On by default with --provider openrouter -- only routes to
                                  providers with a ZDR policy.
  --openrouter-allow-data-collection
                                  Allow routing to providers that collect/train on prompt data (or
                                  KODR_OPENROUTER_ALLOW_DATA_COLLECTION). Denied by default with
                                  --provider openrouter.
  --openrouter-provider-only <a,b> Restrict/prioritize OpenRouter's upstream inference providers,
                                  e.g. "akashml,parasail" (or KODR_OPENROUTER_PROVIDER_ONLY). Maps
                                  to OpenRouter's provider.order. See
                                  https://openrouter.ai/docs/features/provider-routing.
  --prompt, -p <text>             Prompt text (compatibility alias)
  --test <command>                First Stop hook (e.g. "npm test"); see .kodr/hooks.json
  --heal-turns <n>                Max repair turns (default: 3)
  --max-run-ms <n>                Stop between turns after this many ms (default: 0, disabled)
  --max-tool-turns <n>            Tool-turn ceiling per loop (default: 20)
  --max-repeat-tool-errors <n>    Stop after the same tool call fails this many times in a
                                  row (default: 3, or KODR_MAX_REPEAT_TOOL_ERRORS; 0 disables)
  --request-timeout-ms <n>        Hard per-request timeout ceiling, independent of --max-run-ms,
                                  so a stalled backend fails one request instead of hanging
                                  (default: 600000 = 10 min, or KODR_REQUEST_TIMEOUT_MS)
  --max-attempts <n>              For 'kodr goal': cap on build+judge iterations (default: 3,
                                  or KODR_GOAL_MAX_ATTEMPTS)
  --heartbeat-ms <n>              Stop-hook "still running" notice interval (or KODR_HEARTBEAT_MS; default: 30000, 0 disables)
  --incident-heartbeat-ms <n>     On-disk heartbeat interval for detecting a run that
                                  never exited cleanly (or KODR_INCIDENT_HEARTBEAT_MS;
                                  default: 30000, 0 disables)
  --model-retries <n>             Retries for a 5xx chat response, e.g. a local backend crash (or KODR_MODEL_RETRIES; default: 1, 0 disables)
  --context-window <n>            Max context window in tokens; compact at 80% (or KODR_CONTEXT_WINDOW;
                                  auto-detected from the loaded model, falls back to 8192; 0 disables)
  --review-model <id>             Run a review pass on this model after a successful build.
                                  Kodr owns the LM Studio load/unload/verify sequencing for
                                  both models via lms (see specs/lms.yaml). Omitted (the
                                  default): a single model serves both roles, unchanged.
  --review-context-window <n>     Context window for the review model (default: same as --context-window)
  --review-min-tool-calls <n>     Tool-call floor before a review counts as grounded (or
                                  KODR_REVIEW_MIN_TOOL_CALLS; default: 2, 0 disables the floor)
  --review-max-tool-turns <n>     Tool-turn ceiling per review attempt (or KODR_REVIEW_MAX_TOOL_TURNS; default: 12)
  --env <a,b,c>                   Extra env vars to expose to commands (CSV of names)
  --continue <last|path>          Continue from a prior run
  --runs-dir <path>               Where to write run transcripts (or KODR_RUNS_DIR)
  --no-save                       Don't write a run transcript (or KODR_NO_SAVE)
  --raw-then-fix-commits          Commit the build's raw output immediately, then any heal
                                  fix as a separate commit on top (or KODR_RAW_THEN_FIX_COMMITS).
                                  Off by default; skipped with a notice outside a git repo.
  --commit-timeout-ms <n>         Timeout for each git call raw-then-fix commit mode makes
                                  (or KODR_COMMIT_TIMEOUT_MS; default: 30000)
  --memory                        Propose lessons for future runs in this workspace at the
                                  end of the run (or KODR_MEMORY). Off by default. Never
                                  writes to MEMORY.md without a human decision -- an
                                  attended terminal gets a y/N prompt, otherwise a proposal
                                  file is written next to the run transcript.
  --memory-auto-apply             Skip the confirmation prompt and apply proposed notes
                                  directly; opt-in only, for a pipeline that has already
                                  decided to trust the loop.
  --json                          Print a machine-readable run summary to stdout
  --events                        Stream the run as newline-delimited JSON events on stdout
                                  (specs/reporter.yaml); can be combined with --json
  --tui                           Launch the interactive full-screen REPL (specs/tui.yaml);
                                  also "kodr tui". Needs an interactive terminal.
  --approve-commands              In the TUI, prompt for y/N approval before each run_command
  --no-fail                       Always exit 0 (or KODR_NO_FAIL); for external-verifier runs
  --debug                         Write every model request's raw request/response to a
                                  JSONL sidecar next to the run transcript (or KODR_DEBUG).
                                  Off by default; for diagnosing a malformed model response.
  --quiet, -q                     Suppress streaming output
  --help, -h                      Show this help
  --version, -v                   Show version

Examples:
  kodr run "add input validation to server.mjs"
  kodr run -p "add input validation to server.mjs"
  kodr "fix the failing test" --test "node --test"   # --test is a Stop hook
  kodr "add error handling" --continue last
  kodr "/compact" --continue last
  kodr replay last                                    # rerun the last run's own prompt fresh
  kodr goal "the /health route is documented and has a test" --test "node --test" --max-attempts 4
`;
  process.stdout.write(`${help.trim()}\n`);
}

/** @param {CliArgs} args */
async function printModels(args) {
  let client;
  try {
    client = createProvider({
      provider: args.provider,
      baseUrl: args.baseUrl,
      model: args.model,
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  // richModels() (lmstudio) already catches its own errors and degrades to
  // [] -- see model.mjs -- but models() (openrouter/ollama) does not; a
  // connection failure there must not reach the caller as an unhandled
  // rejection (this command isn't wrapped in the `run` subcommand's own
  // try/catch, since subcommands return before reaching it).
  try {
    if (client.capabilities.contextProbing) {
      const models = await client.richModels();
      process.stdout.write(`${formatModelsList(models, args.baseUrl)}\n`);
      return;
    }
    const models = await client.models();
    process.stdout.write(
      `${formatSimpleModelsList(models, resolveProviderName(args.provider), args.baseUrl)}\n`,
    );
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  }
}

/** @param {CliArgs} args */
async function printDoctor(args) {
  const report = await runDoctorChecks({
    provider: args.provider,
    baseUrl: args.baseUrl,
    model: args.model,
  });
  process.stdout.write(`${formatDoctorReport(report)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

/** @param {CliArgs} args */
async function printStats(args) {
  const cwd = resolve(args.cwd || '.');
  const runsDir = resolveRunsDir(cwd, args.runsDir);
  const records = await loadRunRecords(runsDir);
  const stats = computeStats(records);
  process.stdout.write(`${formatStats(stats)}\n`);
}

/**
 * `kodr replay <last|path>` -- re-run a saved run record's original prompt
 * fresh (no prior conversation), against the same cwd/model/test command,
 * to check whether a failure reproduces. See specs/replay.yaml.
 * @param {CliArgs} args
 */
export async function runReplay(args) {
  const ref = args.prompt;
  if (!ref) {
    process.stderr.write('Usage: kodr replay <last|path>\n');
    process.exitCode = 1;
    return;
  }

  const cwd = resolve(args.cwd || '.');
  const runsDir = resolveRunsDir(cwd, args.runsDir);
  const prior = await loadPriorRun(cwd, ref, runsDir);
  if (!prior?.metadata?.prompt) {
    process.stderr.write(
      'No prior run found to replay, or it has no recorded prompt.\n',
    );
    process.exitCode = 1;
    return;
  }

  const options = {
    cwd: prior.metadata.cwd || cwd,
    provider: args.provider || prior.metadata.provider,
    baseUrl: args.baseUrl || prior.metadata.baseUrl,
    model: args.model || prior.metadata.model,
    reasoning: args.reasoning,
    vision: visionEnabled(args),
    noZdr: args.openrouterNoZdr,
    allowDataCollection: args.openrouterAllowDataCollection,
    providerOrder: args.openrouterProviderOnly,
    testCommand: prior.metadata.testCommand || undefined,
    maxHealTurns: prior.metadata.maxHealTurns,
    maxRunMs: prior.metadata.maxRunMs,
    maxToolTurns: prior.metadata.maxToolTurns,
    envPassthrough: prior.metadata.envPassthrough,
    contextWindow: prior.metadata.contextWindow,
    quiet: args.quiet || args.json,
    reporter: args.events ? createJsonReporter() : undefined,
    runsDir: args.runsDir,
    noSave: args.noSave,
    debug: args.debug,
  };

  try {
    const result = await run(prior.metadata.prompt, options);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(summarizeResult(result))}\n`);
    }
    process.exitCode = exitCodeFor(result, args);
  } catch (err) {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ stoppedReason: 'error', error: err.message })}\n`,
      );
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    if (!noFailEnabled(args)) {
      process.exitCode = 1;
    }
  }
}

/**
 * Process exit code for a goal loop: 0 iff the goal was met (unless --no-fail).
 * @param {import('./goal.mjs').GoalResult} result
 * @param {CliArgs} args
 * @returns {number}
 */
export function goalExitCode(result, args) {
  if (noFailEnabled(args)) {
    return 0;
  }
  if (result.met) {
    return 0;
  }
  return 1;
}

/**
 * `kodr goal "<goal>"` — the evaluator loop (specs/goal.yaml). Iterate run()
 * until a read-only model judge confirms the goal is met, or --max-attempts is
 * hit. Each attempt is one full run() (build + test/heal); the judge decides
 * whether to continue and its feedback is carried into the next attempt as a
 * continuation. In P0 the judge runs on the same provider/model as the build.
 * @param {CliArgs} args
 */
export async function runGoalCommand(args) {
  const goal = args.prompt;
  if (!goal) {
    process.stderr.write(
      'Usage: kodr goal "<goal>" [--test cmd] [--max-attempts n]\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1) {
    process.stderr.write('--max-attempts must be a positive integer.\n');
    process.exitCode = 1;
    return;
  }
  const providerName = resolveProviderName(args.provider);
  if (!['lmstudio', 'openrouter', 'ollama'].includes(providerName)) {
    process.stderr.write(
      `Unknown provider "${providerName}" -- must be one of: lmstudio, openrouter, ollama.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cwd = resolve(args.cwd || '.');
  const quiet = args.quiet || args.json;
  const runOptions = {
    cwd,
    provider: args.provider,
    baseUrl: args.baseUrl,
    model: args.model,
    reasoning: args.reasoning,
    vision: visionEnabled(args),
    noZdr: args.openrouterNoZdr,
    allowDataCollection: args.openrouterAllowDataCollection,
    providerOrder: args.openrouterProviderOnly,
    testCommand: args.test,
    maxHealTurns: args.healTurns,
    maxRunMs: args.maxRunMs,
    maxToolTurns: args.maxToolTurns,
    maxRepeatToolErrors: args.maxRepeatToolErrors,
    requestTimeoutMs: args.requestTimeoutMs,
    heartbeatMs: args.heartbeatMs,
    incidentHeartbeatMs: args.incidentHeartbeatMs,
    maxRetries: args.modelRetries,
    envPassthrough: args.env,
    runsDir: args.runsDir,
    noSave: args.noSave,
    memory: args.memory,
    memoryAutoApply: args.memoryAutoApply,
    debug: args.debug,
    quiet,
  };
  if (args.contextWindow !== null) {
    runOptions.contextWindow = args.contextWindow;
  }

  // A dedicated read-only client for the judge; the build's own client lives
  // inside run(). Same provider/model as the build in P0 -- cross-model judging
  // is a future enhancement (specs/goal.yaml).
  let client;
  let judgeModelId;
  try {
    client = createProvider({
      provider: args.provider,
      baseUrl: args.baseUrl,
      model: args.model,
      timeout: resolveRequestTimeoutMs(args.requestTimeoutMs),
      maxRetries: args.modelRetries,
      reasoning: args.reasoning,
      noZdr: args.openrouterNoZdr,
      allowDataCollection: args.openrouterAllowDataCollection,
      providerOrder: args.openrouterProviderOnly,
    });
    judgeModelId = await client.resolveModel();
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const judgeReporter = quiet ? createNullReporter() : createTerminalReporter();
  const loopReporter = quiet ? createNullReporter() : createTerminalReporter();

  const controller = new AbortController();
  runOptions.signal = controller.signal;
  const onSigint = createSigintCanceller(controller);
  process.on('SIGINT', onSigint);
  try {
    const goalResult = await runGoal({
      goal,
      maxAttempts: args.maxAttempts,
      reporter: loopReporter,
      runTask: (prompt, continuation) =>
        run(prompt, {
          ...runOptions,
          priorMessages: continuation?.priorMessages,
          priorFilesChanged: continuation?.priorFilesChanged,
        }),
      evaluate: (result) =>
        evaluateGoal({
          client,
          modelId: judgeModelId,
          cwd,
          goal,
          filesChanged: result.filesChanged || [],
          maxRunMs: args.maxRunMs,
          contextWindow: args.contextWindow ?? 0,
          heartbeatMs: args.heartbeatMs,
          envPassthrough: args.env,
          reporter: judgeReporter,
        }),
    });
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(summarizeGoalResult(goalResult))}\n`,
      );
    }
    process.exitCode = goalExitCode(goalResult, args);
  } catch (err) {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ met: false, reason: 'error', error: err.message })}\n`,
      );
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    if (!noFailEnabled(args)) {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/**
 * `kodr acp` — launch the Agent Client Protocol front-end over stdio
 * (specs/acp.yaml). It owns stdin/stdout as a JSON-RPC channel, so it is
 * mutually exclusive with the output modes that scrape or silence them, and
 * needs no TTY (a client drives it as a subprocess). cwd comes per-session
 * from the client's session/new, so it isn't set on the base options here.
 * @param {CliArgs} args
 */
export async function runAcpCommand(args) {
  if (args.json || args.quiet || args.events || args.tui) {
    process.stderr.write(
      'kodr acp cannot be combined with --json, --quiet, --events, or --tui.\n',
    );
    process.exitCode = 1;
    return;
  }

  const providerName = resolveProviderName(args.provider);
  if (!['lmstudio', 'openrouter', 'ollama'].includes(providerName)) {
    process.stderr.write(
      `Unknown provider "${providerName}" -- must be one of: lmstudio, openrouter, ollama.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const options = {
    cwd: resolve(args.cwd || '.'),
    provider: args.provider,
    baseUrl: args.baseUrl,
    model: args.model,
    reasoning: args.reasoning,
    vision: visionEnabled(args),
    noZdr: args.openrouterNoZdr,
    allowDataCollection: args.openrouterAllowDataCollection,
    providerOrder: args.openrouterProviderOnly,
    testCommand: args.test,
    maxHealTurns: args.healTurns,
    maxRunMs: args.maxRunMs,
    maxToolTurns: args.maxToolTurns,
    maxRepeatToolErrors: args.maxRepeatToolErrors,
    requestTimeoutMs: args.requestTimeoutMs,
    heartbeatMs: args.heartbeatMs,
    incidentHeartbeatMs: args.incidentHeartbeatMs,
    maxRetries: args.modelRetries,
    envPassthrough: args.env,
    runsDir: args.runsDir,
    noSave: args.noSave,
    debug: args.debug,
  };
  if (args.contextWindow !== null) {
    options.contextWindow = args.contextWindow;
  }

  // `--continue <ref>` seeds the first ACP session with a prior run's
  // conversation (specs/acp.yaml), so the model resumes it across an editor
  // relaunch — the same continuation the CLI's own --continue uses. One-shot:
  // later sessions started in this process begin fresh. An unresolvable ref is
  // an error rather than a silent fresh start.
  if (args.continue) {
    const prior = await loadPriorRun(
      options.cwd,
      args.continue,
      resolveRunsDir(options.cwd, args.runsDir),
    );
    if (!prior) {
      process.stderr.write('No prior run found to continue from.\n');
      process.exitCode = 1;
      return;
    }
    options.continueSeed = {
      priorMessages: prior.messages,
      priorFilesChanged: prior.filesChanged || [],
    };
  }

  const { runAcp } = await import('./acp.mjs');
  await runAcp(options);
}

async function printVersion() {
  try {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    process.stdout.write(`kodr ${pkg.version}\n`);
  } catch {
    process.stdout.write('kodr (unknown version)\n');
  }
}

export async function loadPriorRun(cwd, ref, runsDir) {
  const { join } = await import('node:path');
  const { readdir } = await import('node:fs/promises');

  if (ref === 'last') {
    const runDir = runsDir || join(cwd, '.kodr', 'runs');
    try {
      const files = (await readdir(runDir))
        .filter((f) => f.endsWith('.json'))
        .sort();
      if (files.length === 0) {
        return null;
      }
      const last = files[files.length - 1];
      const data = JSON.parse(await readFile(join(runDir, last), 'utf8'));
      return withoutSystemMessages(data);
    } catch {
      return null;
    }
  }

  // Treat ref as a file path
  try {
    const data = JSON.parse(await readFile(resolve(cwd, ref), 'utf8'));
    return withoutSystemMessages(data);
  } catch {
    return null;
  }
}

function withoutSystemMessages(data) {
  if (!Array.isArray(data.messages)) {
    return data;
  }
  return {
    ...data,
    messages: data.messages.filter((message) => message.role !== 'system'),
  };
}
