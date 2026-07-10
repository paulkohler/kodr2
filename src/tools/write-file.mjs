/**
 * write_file tool — create or overwrite a file, path-jailed to workspace.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWritePath } from '../path-jail.mjs';

export default {
  definition: {
    name: 'write_file',
    description:
      'Create or overwrite a file. Path is relative to the workspace root. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path relative to the workspace root, or an absolute path within it',
        },
        content: {
          type: 'string',
          description: 'File content to write',
        },
      },
      required: ['path', 'content'],
    },
  },

  async execute({ path, content }, context) {
    if (!path) {
      return { error: 'path is required' };
    }
    if (content === undefined || content === null) {
      return { error: 'content is required' };
    }

    let resolved;
    try {
      resolved = await resolveWritePath(context.cwd, path);
    } catch (e) {
      return { error: e.message };
    }
    if (!resolved) {
      return { error: 'path escapes workspace root' };
    }

    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
      context.trackWrite(path);
      return { written: true, path };
    } catch (e) {
      return { error: e.message };
    }
  },
};
