/**
 * run_command tool — execute shell commands in the workspace.
 */

import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT = 50_000; // characters

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
		if (!command) return { error: 'command is required' };

		return new Promise((resolve) => {
			const child = execFile(
				'/bin/sh',
				['-c', command],
				{
					cwd: context.cwd,
					timeout: DEFAULT_TIMEOUT,
					maxBuffer: MAX_OUTPUT * 2,
					env: { ...process.env, PATH: process.env.PATH },
				},
				(err, stdout, stderr) => {
					const exitCode = err
						? err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
							? 1
							: (err.code ?? 1)
						: 0;

					resolve({
						stdout: truncate(stdout || '', MAX_OUTPUT),
						stderr: truncate(stderr || '', MAX_OUTPUT),
						exitCode: typeof exitCode === 'number' ? exitCode : 1,
					});
				},
			);
		});
	},
};

function truncate(text, max) {
	if (text.length <= max) return text;
	return text.slice(0, max) + '\n[truncated]';
}
