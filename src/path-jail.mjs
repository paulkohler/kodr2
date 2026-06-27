/**
 * Path jail — confine all filesystem access to the workspace root.
 *
 * Model-supplied paths are untrusted. Every path is resolved against the
 * real (symlink-followed) workspace root and rejected if it escapes, so
 * `../` traversal and symlinks pointing outside the workspace cannot reach
 * the wider filesystem. Resolvers return `null` on escape rather than throw.
 */

import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

/**
 * Resolve a path that must already exist, jailed to the workspace root.
 * @param {string} cwd - Workspace root
 * @param {string} path - Path relative to the root (model-supplied)
 * @returns {Promise<string|null>} Absolute path, or null if it escapes
 */
export async function resolveExistingPath(cwd, path) {
  const root = await realpath(cwd);
  const unresolved = resolve(root, path);
  if (!jailedPath(root, unresolved)) {
    return null;
  }
  const target = await realpath(unresolved);
  return jailedPath(root, target);
}

/**
 * Resolve a path for writing, jailed to the workspace root. The path need not
 * exist yet; its nearest existing parent is validated so a new file cannot be
 * created outside the workspace via a symlinked or traversing parent.
 * @param {string} cwd - Workspace root
 * @param {string} path - Path relative to the root (model-supplied)
 * @returns {Promise<string|null>} Absolute path, or null if it escapes
 */
export async function resolveWritePath(cwd, path) {
  const root = await realpath(cwd);
  const target = resolve(root, path);
  try {
    const existingTarget = await realpath(target);
    return jailedPath(root, existingTarget);
  } catch {
    // New path: validate its nearest existing parent below.
  }
  const parent = await existingParent(dirname(target));
  const realParent = await realpath(parent);
  if (!jailedPath(root, realParent)) {
    return null;
  }
  return jailedPath(root, target) ? target : null;
}

function jailedPath(root, target) {
  const rel = relative(root, target);
  if (rel === '') {
    return target;
  }
  if (rel === '..' || rel.startsWith('../') || resolve(root, rel) !== target) {
    return null;
  }
  return target;
}

async function existingParent(path) {
  let current = path;
  while (true) {
    try {
      await realpath(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error('no existing parent directory');
      }
      current = parent;
    }
  }
}
