/**
 * list_files tool — list directory contents with optional glob filtering.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { resolveExistingPath } from '../path-jail.mjs';
import { shouldIgnoreEntry } from '../ignore.mjs';

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
    let resolved;
    try {
      resolved = await resolveExistingPath(context.cwd, path);
    } catch {
      return { error: `directory not found: ${path}` };
    }
    if (!resolved) {
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
    const root = await realpath(context.cwd);

    if (recursive) {
      await walk(resolved, root, files);
    } else {
      const entries = await readdir(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (shouldIgnoreEntry(entry.name)) {
          continue;
        }
        const rel = relative(root, join(resolved, entry.name));
        const suffix = entry.isDirectory() ? '/' : '';
        files.push(rel + suffix);
        if (files.length >= MAX_ENTRIES) {
          break;
        }
      }
    }

    // Flag the cap so a capped listing isn't read as the whole directory. Set
    // whenever the cap is reached; a listing that lands exactly on MAX_ENTRIES
    // is flagged too, which is the safe direction.
    if (files.length >= MAX_ENTRIES) {
      return { files, truncated: true, limit: MAX_ENTRIES };
    }
    return { files };
  },
};

async function walk(dir, root, files) {
  if (files.length >= MAX_ENTRIES) {
    return;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_ENTRIES) {
      return;
    }
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }

    const full = join(dir, entry.name);
    const rel = relative(root, full);

    if (entry.isDirectory()) {
      files.push(`${rel}/`);
      await walk(full, root, files);
    } else {
      files.push(rel);
    }
  }
}
