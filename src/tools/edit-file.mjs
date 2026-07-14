/**
 * edit_file tool — targeted search/replace edit on an existing file.
 */

import { resolveExistingPath } from '../path-jail.mjs';
import { localBackend } from './backend.mjs';

export default {
  definition: {
    name: 'edit_file',
    description:
      'Apply a search/replace edit to an existing file. The old_string must appear exactly once in the file. Path is relative to workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path relative to the workspace root, or an absolute path within it',
        },
        old_string: {
          type: 'string',
          description: 'Exact text to find (must appear exactly once)',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },

  async execute({ path, old_string, new_string }, context) {
    if (!path) {
      return {
        error:
          'path is required — edit_file needs { "path": "<file>", "old_string": "...", "new_string": "..." }',
      };
    }
    if (!old_string) {
      return {
        error:
          'old_string is required — edit_file needs { "path", "old_string", "new_string" }',
      };
    }
    if (new_string === undefined || new_string === null) {
      return {
        error:
          'new_string is required — edit_file needs { "path", "old_string", "new_string" }',
      };
    }

    let resolved;
    try {
      resolved = await resolveExistingPath(context.cwd, path);
    } catch {
      return { error: `file not found: ${path}` };
    }
    if (!resolved) {
      return { error: 'path escapes workspace root' };
    }

    const backend = context.backend ?? localBackend;
    const read = await backend.readTextFile(resolved);
    if (read.error) {
      return { error: `file not found: ${path}` };
    }
    const content = read.content;

    const count = countOccurrences(content, old_string);
    if (count === 0) {
      return { error: 'old_string not found in file' };
    }
    if (count > 1) {
      return { error: `old_string appears ${count} times — must be unique` };
    }

    // A function replacer, not a string one: a plain string new_string would
    // have its $-tokens ($&, $$, $`, $', $n) interpreted by String.replace and
    // silently rewritten -- corrupting literal text the model meant to insert
    // (e.g. "$$" in a Makefile, or "$&" in a shell script). old_string is
    // already verified unique, so this replaces exactly that one occurrence.
    const updated = content.replace(old_string, () => new_string);

    const written = await backend.writeTextFile(resolved, updated);
    if (written.error) {
      return { error: written.error };
    }
    context.trackWrite(path);
    return { edited: true, path };
  },
};

function countOccurrences(text, search) {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) {
      break;
    }
    count++;
    pos = idx + 1;
  }
  return count;
}
