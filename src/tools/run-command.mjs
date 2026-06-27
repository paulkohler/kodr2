/**
 * run_command tool — execute shell commands in the workspace.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { buildEnv } from '../env.mjs';
import { shouldIgnoreEntry } from '../ignore.mjs';

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT = 50_000; // characters
const MAX_SNAPSHOT_FILES = 1000;

export default {
  definition: {
    name: 'run_command',
    description:
      'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code. Commands time out after 30 seconds.',
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
    const result = await executeCommand(command, context.cwd, {
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
  let match;
  while ((match = pattern.exec(command)) !== null) {
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

export function executeCommand(command, cwd, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? MAX_OUTPUT;
  const env = options.env ?? buildEnv();
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd,
        timeout,
        maxBuffer: maxOutput * 2,
        env,
      },
      (err, stdout, stderr) => {
        let exitCode = 0;
        if (err) {
          exitCode = err.code ?? 1;
        }
        if (exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          exitCode = 1;
        }

        resolve({
          stdout: truncate(stdout || '', maxOutput),
          stderr: truncate(stderr || '', maxOutput),
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
        });
      },
    );
  });
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + '\n[truncated]';
}
