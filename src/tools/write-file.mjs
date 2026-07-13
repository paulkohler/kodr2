/**
 * write_file tool — create or overwrite a file, path-jailed to workspace.
 */

import { resolveWritePath } from '../path-jail.mjs';
import { localBackend } from './backend.mjs';

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

    const backend = context.backend ?? localBackend;
    const written = await backend.writeTextFile(resolved, content);
    if (written.error) {
      return { error: written.error };
    }
    context.trackWrite(path);
    return { written: true, path };
  },
};
