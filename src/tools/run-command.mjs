/**
 * run_command tool — execute shell commands in the workspace.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { buildEnv } from '../env.mjs';
import { shouldIgnoreEntry } from '../ignore.mjs';
import { DEFAULT_TIMEOUT, runShell } from '../shell.mjs';

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
    if (isPackageManagerCommand(command) && context.trackPackageCommand) {
      context.trackPackageCommand(command);
    }
    const before = await snapshotWorkspace(context.cwd);
    const result = await runShell(command, context.cwd, {
      env: buildEnv(context.envPassthrough),
      timeout: commandTimeout(context),
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

export function commandTimeout(context) {
  const configured = context.commandTimeoutMs ?? DEFAULT_TIMEOUT;
  const remaining = remainingRunBudgetMs(context);
  if (remaining === null) {
    return configured;
  }
  return Math.max(1, Math.min(configured, remaining));
}

function remainingRunBudgetMs(context) {
  if (!context.maxRunMs || !context.startedAt) {
    return null;
  }
  return context.maxRunMs - (Date.now() - context.startedAt.getTime());
}

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

export function isPackageManagerCommand(command) {
  return splitCommandSegments(command).some((segment) =>
    PACKAGE_COMMAND_PATTERNS.some((pattern) => pattern.test(segment)),
  );
}

const PACKAGE_COMMAND_PATTERNS = [
  /^npm\s+(install|i|add|uninstall|remove|rm)\b/,
  /^pnpm\s+(install|i|add|remove|rm)\b/,
  /^yarn\s+(add|remove|install)\b/,
  /^bun\s+(install|add|remove)\b/,
  /^pip\s+(install|uninstall)\b/,
  /^pip3\s+(install|uninstall)\b/,
  /^python\s+-m\s+pip\s+(install|uninstall)\b/,
  /^python3\s+-m\s+pip\s+(install|uninstall)\b/,
  /^uv\s+(add|remove|pip\s+install|pip\s+uninstall)\b/,
  /^poetry\s+(add|remove|install)\b/,
  /^cargo\s+(add|remove|install)\b/,
  /^go\s+get\b/,
];

function splitCommandSegments(command) {
  // Split on every shell segment boundary, including the pipe -- otherwise
  // `echo y | npm install foo` reads as a single `echo ...` segment and the
  // package install goes untracked. Keep this in step with findCdTargets,
  // which already treats `|` as a boundary in its cd scan.
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
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
