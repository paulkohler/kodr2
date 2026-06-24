/**
 * search tool — grep across workspace files.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';

const IGNORE = new Set(['.git', 'node_modules', '.kodr']);
const MAX_MATCHES = 100;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

export default {
  definition: {
    name: 'search',
    description:
      'Search for a pattern across workspace files. Returns matching lines with file paths and line numbers. Skips binary files and files over 1MB.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search string (plain text, not regex)',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (default: workspace root)',
        },
        glob: {
          type: 'string',
          description: 'File extension filter, e.g. ".mjs" or ".json"',
        },
      },
      required: ['pattern'],
    },
  },

  async execute({ pattern, path = '.', glob }, context) {
    if (!pattern) return { error: 'pattern is required' };

    const resolved = resolve(context.cwd, path);
    if (!resolved.startsWith(context.cwd) || (resolved !== context.cwd && !resolved.startsWith(context.cwd + '/'))) {
      return { error: 'path escapes workspace root' };
    }

    const matches = [];
    await searchDir(resolved, context.cwd, pattern, glob, matches);
    return { matches };
  },
};

async function searchDir(dir, root, pattern, glob, matches) {
  if (matches.length >= MAX_MATCHES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES) return;
    if (IGNORE.has(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      await searchDir(full, root, pattern, glob, matches);
      continue;
    }

    if (glob && !entry.name.endsWith(glob)) continue;

    try {
      const info = await stat(full);
      if (info.size > MAX_FILE_SIZE) continue;
    } catch {
      continue;
    }

    let content;
    try {
      content = await readFile(full, 'utf8');
    } catch {
      continue;
    }

    if (content.charCodeAt(0) === 0) continue; // binary

    const lines = content.split('\n');
    const rel = relative(root, full);

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES) return;
      if (lines[i].includes(pattern)) {
        matches.push({
          file: rel,
          line: i + 1,
          text: lines[i].slice(0, 200),
        });
      }
    }
  }
}
