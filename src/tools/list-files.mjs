/**
 * list_files tool — list directory contents with optional glob filtering.
 */

import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';

const IGNORE = new Set(['.git', 'node_modules', '.kodr']);
const MAX_ENTRIES = 500;

export default {
  definition: {
    name: 'list_files',
    description:
      'List files in a directory. Path is relative to workspace root. Defaults to the root directory. Returns up to 500 entries. Skips .git, node_modules, and .kodr directories.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path (default: ".")',
        },
        recursive: {
          type: 'boolean',
          description: 'List recursively (default: false)',
        },
      },
    },
  },

  async execute({ path = '.', recursive = false }, context) {
    const resolved = resolve(context.cwd, path);
    if (!resolved.startsWith(context.cwd) || (resolved !== context.cwd && !resolved.startsWith(context.cwd + '/'))) {
      return { error: 'path escapes workspace root' };
    }

    try {
      const info = await stat(resolved);
      if (!info.isDirectory()) {
        return { error: 'not a directory' };
      }
    } catch {
      return { error: `directory not found: ${path}` };
    }

    const files = [];

    if (recursive) {
      await walk(resolved, context.cwd, files);
    } else {
      const entries = await readdir(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORE.has(entry.name)) continue;
        const rel = relative(context.cwd, join(resolved, entry.name));
        const suffix = entry.isDirectory() ? '/' : '';
        files.push(rel + suffix);
        if (files.length >= MAX_ENTRIES) break;
      }
    }

    return { files };
  },
};

async function walk(dir, root, files) {
  if (files.length >= MAX_ENTRIES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_ENTRIES) return;
    if (IGNORE.has(entry.name)) continue;

    const full = join(dir, entry.name);
    const rel = relative(root, full);

    if (entry.isDirectory()) {
      files.push(rel + '/');
      await walk(full, root, files);
    } else {
      files.push(rel);
    }
  }
}
