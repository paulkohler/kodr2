/**
 * write_file tool — create or overwrite a file, path-jailed to workspace.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

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
					description: 'Relative path from workspace root',
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
		if (!path) return { error: 'path is required' };
		if (content === undefined || content === null) {
			return { error: 'content is required' };
		}

		const resolved = resolve(context.cwd, path);
		if (!resolved.startsWith(context.cwd + '/') && resolved !== context.cwd) {
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
