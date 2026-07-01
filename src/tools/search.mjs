/**
 * search tool — grep across workspace files.
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { resolveExistingPath } from '../path-jail.mjs';
import { shouldIgnoreEntry } from '../ignore.mjs';

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
    if (!pattern) {
      return { error: 'pattern is required' };
    }

    let resolved;
    try {
      resolved = await resolveExistingPath(context.cwd, path);
    } catch {
      return { error: `path not found: ${path}` };
    }
    if (!resolved) {
      return { error: 'path escapes workspace root' };
    }

    const matches = [];
    const root = await realpath(context.cwd);

    // `path` may point at a single file (e.g. one just read) rather than a
    // directory — search it directly instead of trying to readdir() it,
    // which would otherwise fail closed with zero matches and no error.
    const info = await stat(resolved);
    if (info.isFile()) {
      await searchFile(resolved, root, pattern, matches);
    } else {
      await searchDir(resolved, root, pattern, glob, matches);
    }
    return { matches };
  },
};

async function searchDir(dir, root, pattern, glob, matches) {
  if (matches.length >= MAX_MATCHES) {
    return;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES) {
      return;
    }
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      await searchDir(full, root, pattern, glob, matches);
      continue;
    }

    if (glob && !entry.name.endsWith(glob)) {
      continue;
    }
    let safePath;
    try {
      safePath = await resolveExistingPath(root, full);
    } catch {
      continue;
    }
    if (!safePath) {
      continue;
    }

    await searchFile(safePath, root, pattern, matches);
  }
}

/**
 * Search a single file for `pattern`, appending line matches to `matches`.
 * Skips files over MAX_FILE_SIZE and binary files. Best effort: any read
 * failure is treated as no matches rather than an error.
 */
async function searchFile(safePath, root, pattern, matches) {
  if (matches.length >= MAX_MATCHES) {
    return;
  }

  try {
    const info = await stat(safePath);
    if (info.size > MAX_FILE_SIZE) {
      return;
    }
  } catch {
    return;
  }

  let content;
  try {
    content = await readFile(safePath, 'utf8');
  } catch {
    return;
  }

  if (content.charCodeAt(0) === 0) {
    return; // binary
  }

  const lines = content.split('\n');
  const rel = relative(root, safePath);

  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= MAX_MATCHES) {
      return;
    }
    if (lines[i].includes(pattern)) {
      matches.push({
        file: rel,
        line: i + 1,
        text: lines[i].slice(0, 200),
      });
    }
  }
}
