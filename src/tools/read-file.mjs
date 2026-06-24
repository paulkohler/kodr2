/**
 * read_file tool — read file contents, path-jailed to workspace.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolveExistingPath } from '../path-jail.mjs';

const MAX_SIZE = 1024 * 1024; // 1 MB

export default {
	definition: {
		name: 'read_file',
		description:
			'Read the contents of a file. Path is relative to the workspace root. Returns an error for binary files or files over 1MB.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Relative path from workspace root',
				},
			},
			required: ['path'],
		},
	},

	async execute({ path }, context) {
		if (!path) return { error: 'path is required' };

		let resolved;
		try {
			resolved = await resolveExistingPath(context.cwd, path);
		} catch {
			return { error: `file not found: ${path}` };
		}
		if (!resolved) {
			return { error: 'path escapes workspace root' };
		}

		try {
			const info = await stat(resolved);
			if (!info.isFile()) {
				return { error: 'not a file' };
			}
			if (info.size > MAX_SIZE) {
				return {
					error: `file too large: ${info.size} bytes (max ${MAX_SIZE})`,
				};
			}
		} catch (e) {
			return { error: `file not found: ${path}` };
		}

		try {
			const content = await readFile(resolved, 'utf8');
			if (isBinary(content)) {
				return { error: 'binary file — cannot read as text' };
			}
			return { content };
		} catch (e) {
			return { error: e.message };
		}
	},
};

function isBinary(content) {
	for (let i = 0; i < Math.min(content.length, 8192); i++) {
		const code = content.charCodeAt(i);
		if (code === 0) return true;
	}
	return false;
}
