/**
 * Raw-then-fix commit mode -- commits the build phase's raw output
 * immediately after the tool loop finishes, and (if a heal pass runs)
 * commits whatever heal changed as a separate commit on top, so the git
 * history always shows what the model actually produced versus what was
 * corrected afterward.
 */

import { runShell } from './shell.mjs';

export const DEFAULT_COMMIT_TIMEOUT_MS = 30_000;

/**
 * Timeout for each git call this module makes. Resolved from an explicit
 * option, then KODR_COMMIT_TIMEOUT_MS, then the default -- a slow
 * pre-commit hook (a full test suite, a formatter) can otherwise exceed a
 * fixed ceiling with no way for a caller to raise it.
 * @param {number} [option]
 * @returns {number}
 */
export function commitTimeoutMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_COMMIT_TIMEOUT_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_COMMIT_TIMEOUT_MS;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/**
 * Whether cwd is inside a git work tree.
 * @param {string} cwd
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export async function isGitRepo(cwd, options = {}) {
  const run = options.run || runShell;
  const result = await run('git rev-parse --is-inside-work-tree', cwd, {
    env: options.env,
    timeout: commitTimeoutMs(options.timeoutMs),
  });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/**
 * Stage and commit exactly the given files -- never `git add -A` or
 * `git add .`, so an auto-commit can't sweep in unrelated changes already
 * sitting in the user's working tree. Cleanly skips (not an error) when
 * there's nothing to commit, and never bypasses the repo's own commit
 * hooks.
 * @param {object} params
 * @param {string} params.cwd
 * @param {string[]} params.files - Files to stage and commit
 * @param {string} params.message - Commit message
 * @param {Record<string, string>} [params.env]
 * @param {number} [params.timeoutMs]
 * @param {function} [params.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<{ committed: boolean, sha?: string, reason?: string, error?: string }>}
 */
export async function commitFiles(params) {
  const { cwd, files, message, env, timeoutMs, run = runShell } = params;

  if (!files || files.length === 0) {
    return { committed: false, reason: 'no files to commit' };
  }

  const shellOptions = { env, timeout: commitTimeoutMs(timeoutMs) };
  const quotedFiles = files.map(shQuote).join(' ');

  const addResult = await run(`git add -- ${quotedFiles}`, cwd, shellOptions);
  if (addResult.exitCode !== 0) {
    return {
      committed: false,
      error: `git add failed: ${combinedOutput(addResult)}`,
    };
  }

  // Exit 0 means no staged diff -- these files produced no actual change
  // (already committed, or reverted back to their original content).
  const diffResult = await run('git diff --cached --quiet', cwd, shellOptions);
  if (diffResult.exitCode === 0) {
    return { committed: false, reason: 'no changes to commit' };
  }

  const commitResult = await run(
    `git commit -m ${shQuote(message)}`,
    cwd,
    shellOptions,
  );
  if (commitResult.exitCode !== 0) {
    return {
      committed: false,
      error: `git commit failed: ${combinedOutput(commitResult)}`,
    };
  }

  const shaResult = await run('git rev-parse HEAD', cwd, shellOptions);
  return { committed: true, sha: shaResult.stdout.trim() };
}
