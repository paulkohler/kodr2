/**
 * CLI argument parsing and dispatch.
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { run } from './harness.mjs';
import { createClient } from './model.mjs';
import { formatModelsList } from './format.mjs';
import { parseEnvNames } from './env.mjs';

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
  if (
    args.contextWindow !== null &&
    (!Number.isInteger(args.contextWindow) || args.contextWindow < 0)
  ) {
    process.stderr.write('--context-window must be a non-negative integer.\n');
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
    quiet: args.quiet,
    envPassthrough: args.env,
  };
  if (args.contextWindow !== null) {
    options.contextWindow = args.contextWindow;
  }

  // Handle continuation
  if (args.continue) {
    const prior = await loadPriorRun(cwd, args.continue);
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
    if (shouldFailProcess(result)) {
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  }
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
    contextWindow: null,
    quiet: false,
    env: [],
    continue: null,
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
    if (arg === '--context-window' && argv[i + 1]) {
      args.contextWindow = parseInt(argv[++i], 10);
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
  --context-window <n>            Max context window in tokens; compact at 80% (default: 8192, 0 disables)
  --env <a,b,c>                   Extra env vars to expose to commands (CSV of names)
  --continue <last|path>          Continue from a prior run
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

export async function loadPriorRun(cwd, ref) {
  const { join } = await import('node:path');
  const { readdir } = await import('node:fs/promises');

  if (ref === 'last') {
    const runDir = join(cwd, '.kodr', 'runs');
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
