/**
 * CLI argument parsing and dispatch.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_COMMIT_TIMEOUT_MS } from './commit.mjs';
import { parseEnvNames } from './env.mjs';
import { formatModelsList } from './format.mjs';
import { DEFAULT_HEARTBEAT_MS, resolveRunsDir, run } from './harness.mjs';
import { DEFAULT_INCIDENT_HEARTBEAT_MS } from './incident.mjs';
import { createClient, DEFAULT_MAX_RETRIES } from './model.mjs';
import {
  DEFAULT_MIN_REVIEW_TOOL_CALLS,
  DEFAULT_REVIEW_MAX_TOOL_TURNS,
} from './review.mjs';
import { MAX_TOOL_TURNS } from './tool-loop.mjs';

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

  if (!args.prompt) {
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

  const cwd = resolve(args.cwd || '.');
  const options = {
    cwd,
    baseUrl: args.baseUrl,
    model: args.model,
    testCommand: args.test,
    maxHealTurns: args.healTurns,
    maxRunMs: args.maxRunMs,
    maxToolTurns: args.maxToolTurns,
    heartbeatMs: args.heartbeatMs,
    incidentHeartbeatMs: args.incidentHeartbeatMs,
    maxRetries: args.modelRetries,
    reviewModel: args.reviewModel,
    reviewMinToolCalls: args.reviewMinToolCalls,
    reviewMaxToolTurns: args.reviewMaxToolTurns,
    quiet: args.quiet || args.json,
    envPassthrough: args.env,
    runsDir: args.runsDir,
    noSave: args.noSave,
    rawThenFixCommits: args.rawThenFixCommits,
    commitTimeoutMs: args.commitTimeoutMs,
    memory: args.memory,
    memoryAutoApply: args.memoryAutoApply,
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
    } else {
      process.stderr.write('No prior run found to continue from.\n');
      process.exitCode = 1;
      return;
    }
  }

  try {
    const result = await run(args.prompt, options);
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
 * Process exit code for a completed run. With --no-fail (or KODR_NO_FAIL) Kodr
 * always exits 0 — for external-verifier contexts (Terminal-Bench, arenas)
 * where the verifier is the judge and a non-zero agent exit is recorded as a
 * harness error rather than a clean reward 0.
 * @param {object} result
 * @param {object} args
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

function noFailEnabled(args) {
  if (args.noFail) {
    return true;
  }
  const env = process.env.KODR_NO_FAIL;
  return env === '1' || env === 'true';
}

/**
 * A compact, machine-readable summary of a run for --json mode. Lets an external
 * harness/adapter read what Kodr did (outcome and cost) without scraping output.
 * @param {object} result
 * @returns {object}
 */
export function summarizeResult(result) {
  return {
    stoppedReason: result.stoppedReason,
    completed: result.stoppedReason === 'complete',
    toolTurns: result.toolTurns ?? 0,
    usage: result.usage ?? { prompt: 0, completion: 0 },
    compactions: result.compactions ?? 0,
    healed: result.healed ?? null,
    healTurns: result.healTurns ?? null,
    verified: result.verification?.passed ?? null,
    noOpCompletion: result.noOpCompletion ?? false,
    filesChanged: result.filesChanged ?? [],
    packageCommands: result.packageCommands ?? [],
    response: result.response ?? '',
    error: result.error?.message ?? null,
    commits: result.commits ?? null,
  };
}

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
 * @returns {object}
 */
export function parseArgs(argv) {
  const args = {
    command: null,
    prompt: null,
    cwd: null,
    baseUrl: null,
    model: null,
    test: null,
    healTurns: 3,
    maxRunMs: 0,
    maxToolTurns: MAX_TOOL_TURNS,
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
    commitTimeoutMs: DEFAULT_COMMIT_TIMEOUT_MS,
    json: false,
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
    if (arg === '--no-fail') {
      args.noFail = true;
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

Options:
  --cwd <path>                    Workspace directory (default: .)
  --base-url <url>                LM Studio URL (default: http://localhost:1234/v1)
  --model <id>                    Model identifier
  --prompt, -p <text>             Prompt text (compatibility alias)
  --test <command>                First Stop hook (e.g. "npm test"); see .kodr/hooks.json
  --heal-turns <n>                Max repair turns (default: 3)
  --max-run-ms <n>                Stop between turns after this many ms (default: 0, disabled)
  --max-tool-turns <n>            Tool-turn ceiling per loop (default: 20)
  --heartbeat-ms <n>              Stop-hook "still running" notice interval (or KODR_HEARTBEAT_MS; default: 30000, 0 disables)
  --incident-heartbeat-ms <n>     On-disk heartbeat interval for detecting a run that
                                  never exited cleanly (or KODR_INCIDENT_HEARTBEAT_MS;
                                  default: 30000, 0 disables)
  --model-retries <n>             Retries for a 5xx chat response, e.g. a local backend crash (or KODR_MODEL_RETRIES; default: 1, 0 disables)
  --context-window <n>            Max context window in tokens; compact at 80% (default: 8192, 0 disables)
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
  --no-fail                       Always exit 0 (or KODR_NO_FAIL); for external-verifier runs
  --quiet, -q                     Suppress streaming output
  --help, -h                      Show this help
  --version, -v                   Show version

Examples:
  kodr run "add input validation to server.mjs"
  kodr run -p "add input validation to server.mjs"
  kodr "fix the failing test" --test "node --test"   # --test is a Stop hook
  kodr "add error handling" --continue last
  kodr "/compact" --continue last
`;
  process.stdout.write(`${help.trim()}\n`);
}

async function printModels(args) {
  const client = createClient({ baseUrl: args.baseUrl, model: args.model });
  const models = await client.richModels();
  process.stdout.write(`${formatModelsList(models, args.baseUrl)}\n`);
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
