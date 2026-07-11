/**
 * Thin wrapper over LM Studio's `lms` CLI for explicit model load/unload
 * and context-size verification.
 *
 * The chat completions HTTP API has no way to request a context window
 * size -- that's only settable at load time via `lms load -c` -- so
 * switching between a build model and a review model at a specific
 * context size requires shelling out, not just changing which model id a
 * request names.
 */

import { runShell as defaultRunShell } from './shell.mjs';

export const DEFAULT_LMS_TIMEOUT_MS = 120_000; // model loads can take a while
export const DEFAULT_LOAD_TTL_SEC = 600; // 10 minutes

/**
 * Timeout for an lms invocation. Resolved from an explicit option, then
 * KODR_LMS_TIMEOUT_MS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function lmsTimeoutMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_LMS_TIMEOUT_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_LMS_TIMEOUT_MS;
}

/**
 * Seconds of inactivity before LM Studio unloads a model on its own.
 * Resolved from an explicit option, then KODR_LMS_TTL_SEC, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function lmsLoadTtlSec(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_LMS_TTL_SEC, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_LOAD_TTL_SEC;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @typedef {object} LmsOptions
 * @property {string} [cwd]
 * @property {Record<string, string>} [env]
 * @property {number} [timeoutMs]
 * @property {function} [run] - Overridable for tests; defaults to shell.mjs's runShell
 */

/**
 * Run an lms subcommand and normalize its result. runShell (and any test
 * double standing in for it) returns { stdout, stderr, exitCode } -- this
 * combines stdout/stderr into a single `output` for error messages, while
 * keeping `stdout` alone available for callers (like listLoadedModels)
 * that need to parse it as JSON and can't risk stray stderr noise
 * corrupting that.
 * @param {string[]} args
 * @param {LmsOptions} options
 */
async function runLms(args, { cwd, env, timeoutMs, run = defaultRunShell }) {
  const command = `lms ${args.map(shQuote).join(' ')}`;
  const result = await run(command, cwd || process.cwd(), {
    env,
    timeout: lmsTimeoutMs(timeoutMs),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? '',
    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
  };
}

/**
 * Unload every currently-loaded model.
 * @param {LmsOptions} [options]
 * @returns {Promise<{ error?: string }>}
 */
export async function unloadAllModels(options = {}) {
  const result = await runLms(['unload', '--all'], options);
  if (result.exitCode !== 0) {
    return { error: `lms unload --all failed: ${result.output}` };
  }
  return {};
}

/**
 * Load a model at a given context size.
 * @param {object} options
 * @param {string} options.model - Model key (also used as --identifier)
 * @param {number} [options.contextWindow] - Context length in tokens
 * @param {number} [options.ttlSec] - Seconds of inactivity before auto-unload
 * @param {string} [options.cwd]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<{ error?: string }>}
 */
export async function loadModel(options) {
  const { model, contextWindow, ttlSec } = options;
  const args = [
    'load',
    model,
    '--gpu',
    'max',
    '--ttl',
    String(lmsLoadTtlSec(ttlSec)),
    '--identifier',
    model,
    '-y',
  ];
  if (contextWindow) {
    args.push('-c', String(contextWindow));
  }
  const result = await runLms(args, options);
  if (result.exitCode !== 0) {
    return { error: `lms load ${model} failed: ${result.output}` };
  }
  return {};
}

/**
 * List models currently loaded in memory.
 * @param {LmsOptions} [options]
 * @returns {Promise<{ models?: Array, error?: string }>}
 */
export async function listLoadedModels(options = {}) {
  const result = await runLms(['ps', '--json'], options);
  if (result.exitCode !== 0) {
    return { error: `lms ps failed: ${result.output}` };
  }
  try {
    return { models: JSON.parse(result.stdout) };
  } catch {
    return {
      error: `lms ps --json returned unparseable output: ${result.stdout.slice(0, 200)}`,
    };
  }
}

/**
 * Unload everything, load the requested model at the requested context
 * size, then verify via `lms ps` that it actually took. LM Studio can
 * silently load a model at a different context size than requested, so
 * the load call succeeding isn't treated as sufficient on its own.
 * @param {object} options
 * @param {string} options.model - Model key to load
 * @param {number} [options.contextWindow] - Context length in tokens (0 or
 *   omitted skips the context-length check)
 * @param {number} [options.ttlSec] - Seconds of inactivity before auto-unload
 * @param {string} [options.cwd]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<{ model?: object, error?: string }>}
 */
export async function ensureModelLoaded(options) {
  const { model, contextWindow } = options;

  const unloadResult = await unloadAllModels(options);
  if (unloadResult.error) {
    return unloadResult;
  }

  const loadResult = await loadModel(options);
  if (loadResult.error) {
    return loadResult;
  }

  const psResult = await listLoadedModels(options);
  if (psResult.error) {
    return psResult;
  }

  const loaded = psResult.models.find((entry) => entry.identifier === model);
  if (!loaded) {
    return { error: `lms load reported success but ${model} is not in lms ps` };
  }
  if (contextWindow && loaded.contextLength !== contextWindow) {
    return {
      error: `${model} loaded at context ${loaded.contextLength}, expected ${contextWindow}`,
    };
  }
  return { model: loaded };
}
