/**
 * run_command tool — execute shell commands in the workspace.
 */

import { execFile } from 'node:child_process';
import { buildEnv } from '../env.mjs';

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
		return executeCommand(command, context.cwd, {
			env: buildEnv(context.envPassthrough),
		});
	},
};

export function executeCommand(command, cwd, options = {}) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const maxOutput = options.maxOutput ?? MAX_OUTPUT;
	const env = options.env ?? buildEnv();
	return new Promise((resolve) => {
		const child = execFile(
			'/bin/sh',
			['-c', command],
			{
				cwd,
				timeout,
				maxBuffer: maxOutput * 2,
				env,
			},
			(err, stdout, stderr) => {
				let exitCode = 0;
				if (err) exitCode = err.code ?? 1;
				if (exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') exitCode = 1;

				resolve({
					stdout: truncate(stdout || '', maxOutput),
					stderr: truncate(stderr || '', maxOutput),
					exitCode: typeof exitCode === 'number' ? exitCode : 1,
				});
			},
		);
	});
}

function truncate(text, max) {
	if (text.length <= max) return text;
	return text.slice(0, max) + '\n[truncated]';
}
