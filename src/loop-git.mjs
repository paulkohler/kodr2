/**
 * The loop ratchet's git surface (specs/loop.yaml) -- every operation a
 * returned value, never a throw, per AGENTS.md's module-boundary rule. Two
 * primitives cover the whole ratchet: commitAll (green, and the park mark)
 * and park (the destructive reset -> clean -> resetPaths sequence). A caller
 * marks the checklist between park's git side effects and the mark commit --
 * this module never touches the checklist file itself.
 *
 * resetPaths deletion is jailed through path-jail.mjs (the same jail the
 * file tools use) rather than a hand-rolled prefix check, so '.', '..',
 * '.git', an absolute path, and any traversal out of cwd are refused by
 * shared, already-tested code.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { commitTimeoutMs } from './commit.mjs';
import { resolveWritePath } from './path-jail.mjs';
import { runShell } from './shell.mjs';

// A raw-string check on the literal entry ('.', '..', '.git') is a cheap
// early exit, but it is not the real defense -- 'data/../.git', './.git' and
// (on a case-insensitive filesystem) '.GIT' all resolve to the same target
// without ever matching these strings. The real check is isInsideGitDir
// below, against the *resolved* path.
const REFUSED_LITERALS = new Set(['.', '..', '.git']);

/**
 * Whether `target` is cwd's own `.git` directory, or lives inside it --
 * checked against the resolved/realpath'd path, not the raw entry string, so
 * 'data/../.git', './.git', and a case-insensitive '.GIT' can't slip past
 * REFUSED_LITERALS's literal string match. Never wiping the repo's own git
 * directory holds regardless of spelling.
 * @param {string} root - Already realpath'd workspace root
 * @param {string} target - Already realpath'd candidate
 * @returns {Promise<boolean>}
 */
async function isInsideGitDir(root, target) {
  let gitDir;
  try {
    gitDir = await realpath(resolve(root, '.git'));
  } catch {
    // No .git at the conventional location (a linked worktree, say) --
    // nothing to compare against, so this check can't fire.
    return false;
  }
  if (target === gitDir) {
    return true;
  }
  const rel = relative(gitDir, target);
  return rel !== '' && !rel.startsWith('..');
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function shellOptionsFor(options) {
  return { env: options.env, timeout: commitTimeoutMs(options.timeoutMs) };
}

/**
 * Whether cwd is inside a git work tree.
 * @param {string} cwd
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<boolean>}
 */
export async function isGitRepo(cwd, options = {}) {
  const run = options.run || runShell;
  const result = await run(
    'git rev-parse --is-inside-work-tree',
    cwd,
    shellOptionsFor(options),
  );
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/**
 * Whether the repo has at least one commit. `git reset --hard` is a silent
 * no-op with no HEAD, so a park would fall through to `git clean -fd` with
 * nothing tracked -- deleting every untracked file, the checklist included.
 * @param {string} cwd
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<boolean>}
 */
export async function hasCommits(cwd, options = {}) {
  const run = options.run || runShell;
  const result = await run(
    'git rev-parse --verify HEAD',
    cwd,
    shellOptionsFor(options),
  );
  return result.exitCode === 0;
}

/**
 * `git add -A && git commit -m <message>`. Used both for a green task's
 * commit and for committing a park mark -- both are "commit everything
 * currently in the tree," just with a different message and a different
 * point in the sequence relative to the destructive park ops.
 * @param {string} cwd
 * @param {string} message
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<{ ok: boolean, sha?: string, error?: string, reason?: string }>}
 */
export async function commitAll(cwd, message, options = {}) {
  const run = options.run || runShell;
  const shellOptions = shellOptionsFor(options);

  const addResult = await run('git add -A', cwd, shellOptions);
  if (addResult.exitCode !== 0) {
    return { ok: false, error: `git add failed: ${combinedOutput(addResult)}` };
  }

  const diffResult = await run('git diff --cached --quiet', cwd, shellOptions);
  if (diffResult.exitCode === 0) {
    return { ok: false, reason: 'no changes to commit' };
  }

  const commitResult = await run(
    `git commit -m ${shQuote(message)}`,
    cwd,
    shellOptions,
  );
  if (commitResult.exitCode !== 0) {
    return {
      ok: false,
      error: `git commit failed: ${combinedOutput(commitResult)}`,
    };
  }

  const shaResult = await run('git rev-parse HEAD', cwd, shellOptions);
  return { ok: true, sha: shaResult.stdout.trim() };
}

/**
 * Whether git tracks anything at `relPath` (a file, or a directory holding
 * tracked files). Used two ways: the loop refuses to start when the
 * checklist itself isn't tracked (an untracked file is deleted outright by
 * the first park's `git clean -fd`), and resetPaths refuses to wipe a path
 * git tracks anything under (a park's mark commit immediately follows with
 * `git add -A`, which would stage and permanently commit the deletion).
 * `git status` exit codes don't distinguish "clean" from "no such path" the
 * way this needs, so this checks `ls-files` directly rather than
 * `check-ignore` (a path can be untracked without being gitignored, and
 * still be safe to wipe).
 * @param {string} cwd
 * @param {string} relPath
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<boolean>}
 */
export async function isTracked(cwd, relPath, options = {}) {
  const run = options.run || runShell;
  const result = await run(
    `git ls-files -- ${shQuote(relPath)}`,
    cwd,
    shellOptionsFor(options),
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Wipe each configured resetPaths entry, jailed to cwd. Only meant to be
 * called after a `git reset --hard`, so this only ever throws away an
 * abandoned attempt's own gitignored/untracked state, never a still-current
 * commit's -- a path git tracks anything under is refused, not wiped. A
 * wiped directory is recreated empty rather than left missing -- a storage
 * layer that opens a file inside it typically never mkdirs it itself.
 * @param {string} cwd
 * @param {string[]} resetPaths
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<{ wiped: string[], refused: string[] }>}
 */
export async function wipeResetPaths(cwd, resetPaths = [], options = {}) {
  const wiped = [];
  const refused = [];
  let root;
  try {
    root = await realpath(cwd);
  } catch {
    root = resolve(cwd);
  }

  for (const raw of resetPaths) {
    const trimmed = String(raw).trim();
    // An absolute path is refused outright, even one that happens to resolve
    // inside cwd -- resetPaths is documented as relative, gitignored paths,
    // and a bare "the resolved target didn't escape root" check would accept
    // one anyway (path.resolve treats an absolute second argument as already
    // final, ignoring root entirely).
    if (REFUSED_LITERALS.has(trimmed) || trimmed.startsWith('/')) {
      refused.push(raw);
      continue;
    }
    const target = await resolveWritePath(cwd, trimmed);
    if (!target || target === root) {
      refused.push(raw);
      continue;
    }
    if (await isInsideGitDir(root, target)) {
      refused.push(raw);
      continue;
    }
    if (await isTracked(cwd, trimmed, options)) {
      refused.push(raw);
      continue;
    }

    let wasDir = false;
    try {
      const info = await stat(target);
      wasDir = info.isDirectory();
    } catch {
      // Nothing at this path -- nothing to wipe.
      continue;
    }
    try {
      await rm(target, { recursive: true, force: true });
      if (wasDir) {
        await mkdir(target, { recursive: true });
      }
    } catch {
      // A filesystem error (permissions, a race) -- refuse rather than throw,
      // per this module's "every operation a returned value" contract.
      refused.push(raw);
      continue;
    }
    wiped.push(raw);
  }

  return { wiped, refused };
}

/**
 * The park sequence's git side effects: `git reset --hard` to discard the
 * failed attempt(s), `git clean -fd` to remove untracked debris (no -x, so a
 * gitignored path like a database is left alone -- that's resetPaths's job),
 * then resetPaths. Never touches the checklist or commits -- the caller
 * marks the checklist and commits the mark afterward, since the mark has to
 * follow the reset.
 * @param {string} cwd
 * @param {string[]} resetPaths
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<{ ok: boolean, error?: string, wiped?: string[], refused?: string[] }>}
 */
export async function park(cwd, resetPaths = [], options = {}) {
  const run = options.run || runShell;
  const shellOptions = shellOptionsFor(options);

  const resetResult = await run('git reset --hard', cwd, shellOptions);
  if (resetResult.exitCode !== 0) {
    return {
      ok: false,
      error: `git reset --hard failed: ${combinedOutput(resetResult)}`,
    };
  }

  const cleanResult = await run('git clean -fd', cwd, shellOptions);
  if (cleanResult.exitCode !== 0) {
    return {
      ok: false,
      error: `git clean -fd failed: ${combinedOutput(cleanResult)}`,
    };
  }

  const { wiped, refused } = await wipeResetPaths(cwd, resetPaths, options);
  return { ok: true, wiped, refused };
}

/**
 * Register entries (e.g. `.kodr/`) in `.git/info/exclude` -- a local ignore,
 * not the project's tracked .gitignore, so a bare `git add -A` skips them
 * with a clean exit 0 regardless of which mechanism ignores it. Idempotent:
 * an already-present line is left alone.
 * @param {string} cwd
 * @param {string[]} entries
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.run] - Overridable for tests; defaults to shell.mjs's runShell
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function registerExcludes(cwd, entries, options = {}) {
  const run = options.run || runShell;
  const gitDirResult = await run(
    'git rev-parse --git-dir',
    cwd,
    shellOptionsFor(options),
  );
  if (gitDirResult.exitCode !== 0) {
    return {
      ok: false,
      error: `git rev-parse --git-dir failed: ${combinedOutput(gitDirResult)}`,
    };
  }

  const gitDir = resolve(cwd, gitDirResult.stdout.trim());
  const excludeDir = join(gitDir, 'info');
  const excludePath = join(excludeDir, 'exclude');

  await mkdir(excludeDir, { recursive: true });
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf8');
  } catch {
    // No exclude file yet -- starts empty.
  }

  const existingLines = new Set(existing.split('\n').map((line) => line));
  const toAdd = entries.filter((entry) => !existingLines.has(entry));
  if (toAdd.length === 0) {
    return { ok: true };
  }

  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(excludePath, `${existing}${separator}${toAdd.join('\n')}\n`);
  return { ok: true };
}
