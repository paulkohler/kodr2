/**
 * run_command tool — execute shell commands in the workspace.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { buildEnv } from '../env.mjs';
import { shouldIgnoreEntry } from '../ignore.mjs';
import { runShell } from '../shell.mjs';

const MAX_SNAPSHOT_FILES = 1000;

export default {
  definition: {
    name: 'run_command',
    description:
      'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code. Commands time out after 10 minutes.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
      },
      required: ['command'],
    },
  },

  async execute({ command }, context) {
    if (!command) {
      return { error: 'command is required' };
    }
    const cdError = validateCdTargets(command, context.cwd);
    if (cdError) {
      return { error: cdError };
    }
    if (context.trackCommand) {
      context.trackCommand();
    }
    const before = await snapshotWorkspace(context.cwd);
    const result = await runShell(command, context.cwd, {
      env: buildEnv(context.envPassthrough),
    });
    const changed = await changedFiles(context.cwd, before);
    for (const path of changed) {
      if (context.trackWrite) {
        context.trackWrite(path);
      }
    }
    if (changed.length > 0) {
      result.filesChanged = changed;
    }
    return result;
  },
};

export async function snapshotWorkspace(cwd) {
  const files = new Map();
  await snapshotDir(cwd, cwd, files);
  return files;
}

export async function changedFiles(cwd, before) {
  const after = await snapshotWorkspace(cwd);
  const changed = [];
  for (const [path, sig] of after) {
    if (before.get(path) !== sig) {
      changed.push(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      changed.push(path);
    }
  }
  return changed.sort();
}

async function snapshotDir(dir, root, files) {
  if (files.size >= MAX_SNAPSHOT_FILES) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.size >= MAX_SNAPSHOT_FILES) {
      return;
    }
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await snapshotDir(full, root, files);
      continue;
    }
    try {
      const info = await stat(full);
      const path = relative(root, full);
      files.set(path, `${info.size}:${info.mtimeMs}`);
    } catch {
      // File disappeared during the snapshot.
    }
  }
}

export function validateCdTargets(command, cwd) {
  for (const target of findCdTargets(command)) {
    const resolved = resolve(cwd, target);
    if (!isInside(cwd, resolved)) {
      return `cd target escapes workspace: ${target}`;
    }
  }
  return null;
}

function findCdTargets(command) {
  const targets = [];
  const pattern = /(^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  for (const match of command.matchAll(pattern)) {
    const target = match[2] || match[3] || match[4];
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '') {
    return true;
  }
  if (rel.startsWith('..')) {
    return false;
  }
  if (rel.startsWith('/')) {
    return false;
  }
  return true;
}
