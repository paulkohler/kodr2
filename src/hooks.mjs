/**
 * Hooks — user-defined shell commands bound to harness lifecycle events.
 *
 * The deterministic, operator-controlled counterpart to the model's tool calls:
 * the operator decides what runs and when, the harness runs it. The first event
 * is "Stop", which fires when the agent finishes its turn. A Stop hook that
 * exits non-zero blocks the stop — its output feeds back through the heal loop
 * and the agent keeps working.
 *
 * Stop hooks generalize the old testCommand/verify/heal flow: `--test` is just
 * the first Stop hook, and verify() is the per-hook executor.
 *
 * Hooks are user-defined and therefore trusted, unlike model output. They still
 * run with the curated child environment and a workspace-jailed cwd.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildEnv } from './env.mjs';
import { verify } from './verify.mjs';

/**
 * Load the hooks config from `.kodr/hooks.json`. A missing file means no hooks.
 * A malformed file is reported as an error value (never thrown); callers should
 * surface it and continue with no hooks.
 * @param {string} cwd - Workspace root (absolute)
 * @returns {Promise<{ config: { hooks: object }, error: string | null }>}
 */
export async function loadHooks(cwd) {
  const file = join(cwd, '.kodr', 'hooks.json');

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { config: { hooks: {} }, error: null };
  }

  try {
    const parsed = JSON.parse(raw);
    return { config: normalizeConfig(parsed), error: null };
  } catch (err) {
    return {
      config: { hooks: {} },
      error: `ignoring .kodr/hooks.json: ${err.message}`,
    };
  }
}

function normalizeConfig(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { hooks: {} };
  }
  if (!parsed.hooks || typeof parsed.hooks !== 'object') {
    return { hooks: {} };
  }
  return parsed;
}

/**
 * Build the ordered list of Stop hooks: the `--test` command (if set) first,
 * then any valid Stop hooks from the config. Invalid entries are dropped.
 * @param {{ hooks?: object }} config
 * @param {string | null} [testCommand]
 * @returns {Array<{ run: string, name: string, runWhenUnchanged: boolean, timeout?: number }>}
 */
export function stopHooks(config, testCommand) {
  const list = [];

  if (testCommand) {
    list.push(normalizeHook({ run: testCommand, name: 'test' }));
  }

  const configured = config?.hooks?.Stop;
  if (Array.isArray(configured)) {
    for (const hook of configured) {
      if (isValidHook(hook)) {
        list.push(normalizeHook(hook));
      }
    }
  }

  return list;
}

function isValidHook(hook) {
  if (!hook || typeof hook !== 'object') {
    return false;
  }
  return typeof hook.run === 'string' && hook.run.trim() !== '';
}

function normalizeHook(hook) {
  const normalized = {
    run: hook.run,
    name: hook.name || hook.run,
    runWhenUnchanged: hook.runWhenUnchanged === true,
  };
  if (Number.isInteger(hook.timeout) && hook.timeout > 0) {
    normalized.timeout = hook.timeout;
  }
  return normalized;
}

/**
 * Run a Stop hook sequence in declared order. Stops at the first failing hook
 * (every Stop hook is blocking) and returns a verify-shaped aggregate so the
 * existing heal loop can consume it unchanged.
 * @param {Array} hooks - Normalized Stop hooks (from stopHooks)
 * @param {string} cwd - Workspace root
 * @param {object} options
 * @param {Record<string, string>} [options.env] - Child environment
 * @param {number} [options.budgetMs] - Remaining run budget; caps each timeout
 * @param {boolean} [options.touchedWorkspace] - Whether the workspace changed
 * @param {number} [options.maxOutput] - Max characters of combined output
 * @returns {Promise<{ passed: boolean, command: string, output: string, exitCode: number, results: Array }>}
 */
export async function runStopHooks(hooks, cwd, options = {}) {
  const { env, budgetMs, touchedWorkspace = false, maxOutput } = options;
  const results = [];

  for (const hook of hooks) {
    if (!shouldRunHook(hook, touchedWorkspace)) {
      continue;
    }

    const result = await verify(hook.run, cwd, {
      env,
      timeout: resolveHookTimeout(hook.timeout, budgetMs),
      maxOutput,
    });
    results.push({ name: hook.name, ...result });

    if (!result.passed) {
      return aggregate(results, false, result);
    }
  }

  return aggregate(results, true, null);
}

function shouldRunHook(hook, touchedWorkspace) {
  if (touchedWorkspace) {
    return true;
  }
  return hook.runWhenUnchanged;
}

/**
 * Resolve a hook's timeout: the smaller of its own timeout and the remaining
 * run budget. Returns undefined when neither is set, letting verify apply its
 * default.
 */
export function resolveHookTimeout(hookTimeout, budgetMs) {
  const candidates = [];
  if (Number.isInteger(hookTimeout) && hookTimeout > 0) {
    candidates.push(hookTimeout);
  }
  if (typeof budgetMs === 'number' && budgetMs > 0) {
    candidates.push(budgetMs);
  }
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.min(...candidates);
}

/**
 * Fold per-hook results into a single verify-shaped result. When blocked, the
 * failing hook's command and output drive the heal feedback and no-progress
 * checks.
 */
function aggregate(results, passed, failed) {
  if (failed) {
    return {
      passed: false,
      command: failed.command,
      output: failed.output,
      exitCode: failed.exitCode,
      results,
    };
  }
  return { passed, command: '', output: '', exitCode: 0, results };
}

/**
 * Build the normalized hook list for a tool event (PreToolUse / PostToolUse).
 * Invalid entries are dropped.
 * @param {{ hooks?: object }} config
 * @param {string} event - "PreToolUse" or "PostToolUse"
 * @returns {Array<{ run: string, name: string, match?: string, timeout?: number }>}
 */
export function toolHooks(config, event) {
  const list = [];
  const configured = config?.hooks?.[event];
  if (Array.isArray(configured)) {
    for (const hook of configured) {
      if (isValidHook(hook)) {
        list.push(normalizeToolHook(hook));
      }
    }
  }
  return list;
}

function normalizeToolHook(hook) {
  const normalized = { run: hook.run, name: hook.name || hook.run };
  if (typeof hook.match === 'string' && hook.match.trim() !== '') {
    normalized.match = hook.match;
  }
  if (Number.isInteger(hook.timeout) && hook.timeout > 0) {
    normalized.timeout = hook.timeout;
  }
  return normalized;
}

/**
 * Whether a tool hook applies to a tool name. A hook with no match runs for
 * every tool; an invalid match regex never matches.
 * @param {{ match?: string }} hook
 * @param {string} toolName
 * @returns {boolean}
 */
export function hookMatches(hook, toolName) {
  if (!hook.match) {
    return true;
  }
  try {
    return new RegExp(hook.match).test(toolName);
  } catch {
    return false;
  }
}

/**
 * Run PreToolUse hooks for a call. The first matching hook that exits non-zero
 * denies the call.
 * @param {Array} hooks - Normalized PreToolUse hooks
 * @param {{ name: string, args: object }} call
 * @param {string} cwd
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.budgetMs]
 * @returns {Promise<{ denied: boolean, reason: string }>}
 */
export async function runPreToolHooks(hooks, call, cwd, options = {}) {
  for (const hook of hooks) {
    if (!hookMatches(hook, call.name)) {
      continue;
    }
    const result = await verify(hook.run, cwd, {
      env: toolHookEnv(options.env, call),
      timeout: resolveHookTimeout(hook.timeout, options.budgetMs),
    });
    if (!result.passed) {
      const reason =
        `denied by PreToolUse hook "${hook.name}": ${result.output}`.trim();
      return { denied: true, reason };
    }
  }
  return { denied: false, reason: '' };
}

/**
 * Run PostToolUse hooks for a completed call. Hooks never revoke the result;
 * any that fail contribute feedback for the model.
 * @param {Array} hooks - Normalized PostToolUse hooks
 * @param {{ name: string, args: object }} call
 * @param {*} result - The tool result
 * @param {string} cwd
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.budgetMs]
 * @returns {Promise<{ feedback: string }>}
 */
export async function runPostToolHooks(hooks, call, result, cwd, options = {}) {
  const notes = [];
  for (const hook of hooks) {
    if (!hookMatches(hook, call.name)) {
      continue;
    }
    const hookResult = await verify(hook.run, cwd, {
      env: toolHookEnv(options.env, call, result),
      timeout: resolveHookTimeout(hook.timeout, options.budgetMs),
    });
    if (!hookResult.passed) {
      notes.push(
        `PostToolUse hook "${hook.name}" failed: ${hookResult.output}`.trim(),
      );
    }
  }
  return { feedback: notes.join('\n') };
}

/**
 * Build the child environment for a tool hook: the curated env plus the call's
 * name, arguments, target file, and (for PostToolUse) the result.
 */
function toolHookEnv(baseEnv, call, result) {
  const env = { ...(baseEnv || buildEnv()) };
  env.KODR_TOOL_NAME = call.name;
  env.KODR_TOOL_ARGS = safeStringify(call.args);
  if (call.args && typeof call.args.path === 'string') {
    env.KODR_TOOL_FILE = call.args.path;
  }
  if (result !== undefined) {
    env.KODR_TOOL_RESULT = safeStringify(result);
  }
  return env;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

/**
 * Build the normalized hook list for a session event (SessionStart /
 * SessionEnd). Invalid entries are dropped.
 * @param {{ hooks?: object }} config
 * @param {string} event - "SessionStart" or "SessionEnd"
 * @returns {Array<{ run: string, name: string, timeout?: number }>}
 */
export function sessionHooks(config, event) {
  const list = [];
  const configured = config?.hooks?.[event];
  if (Array.isArray(configured)) {
    for (const hook of configured) {
      if (isValidHook(hook)) {
        list.push(normalizeSessionHook(hook));
      }
    }
  }
  return list;
}

function normalizeSessionHook(hook) {
  const normalized = { run: hook.run, name: hook.name || hook.run };
  if (Number.isInteger(hook.timeout) && hook.timeout > 0) {
    normalized.timeout = hook.timeout;
  }
  return normalized;
}

/**
 * Run session hooks in declared order. Non-blocking: a failure never aborts the
 * run. Hooks that succeed with stdout contribute context (SessionStart injects
 * it into the conversation); hooks that fail contribute a failure notice.
 * @param {Array} hooks - Normalized session hooks
 * @param {string} cwd
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.budgetMs]
 * @returns {Promise<{ context: Array<{ name: string, output: string }>, failures: Array<{ name: string, output: string }> }>}
 */
export async function runSessionHooks(hooks, cwd, options = {}) {
  const context = [];
  const failures = [];
  for (const hook of hooks) {
    const result = await verify(hook.run, cwd, {
      env: options.env,
      timeout: resolveHookTimeout(hook.timeout, options.budgetMs),
    });
    if (!result.passed) {
      failures.push({ name: hook.name, output: result.output });
    } else if (result.output) {
      context.push({ name: hook.name, output: result.output });
    }
  }
  return { context, failures };
}
