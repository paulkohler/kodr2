import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

export async function resolveExistingPath(cwd, path) {
  const root = await realpath(cwd);
  const unresolved = resolve(root, path);
  if (!jailedPath(root, unresolved)) {
    return null;
  }
  const target = await realpath(unresolved);
  return jailedPath(root, target);
}

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
