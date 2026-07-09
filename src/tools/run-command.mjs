/**
 * run_command tool — execute shell commands in the workspace.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { buildEnv } from '../env.mjs';
import { shouldIgnoreEntry } from '../ignore.mjs';
import { DEFAULT_TIMEOUT, runShell } from '../shell.mjs';

export const DEFAULT_SNAPSHOT_CAP = 1000;

/**
 * Max files the changed-file snapshot walks before stopping. The snapshot is
 * bounded so a huge tree can't make every run_command call walk the whole
 * workspace twice -- but the cap is overridable (per AGENTS.md: operational
 * limits must be changeable by callers), because a file past the cap in
 * traversal order would otherwise be silently missed from changed-file
 * tracking, and so dropped from the run's filesChanged and any commit. Resolved
 * from a registry option, then KODR_SNAPSHOT_CAP, then the default.
 * @param {object} [context]
 * @returns {number}
 */
export function snapshotCap(context) {
  const option = context?.snapshotCap;
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_SNAPSHOT_CAP || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_SNAPSHOT_CAP;
}

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
    const cap = snapshotCap(context);
    const before = await snapshotWorkspace(context.cwd, cap);
    const result = await runShell(command, context.cwd, {
      env: buildEnv(context.envPassthrough),
      timeout: commandTimeout(context),
    });
    const changed = await changedFiles(context.cwd, before, cap);
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

export async function snapshotWorkspace(cwd, cap = DEFAULT_SNAPSHOT_CAP) {
  const files = new Map();
  await snapshotDir(cwd, cwd, files, cap);
  return files;
}

export async function changedFiles(cwd, before, cap = DEFAULT_SNAPSHOT_CAP) {
  const after = await snapshotWorkspace(cwd, cap);
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

async function snapshotDir(dir, root, files, cap) {
  if (files.size >= cap) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.size >= cap) {
      return;
    }
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await snapshotDir(full, root, files, cap);
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
