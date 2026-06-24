/**
 * Verification runner.
 * Runs a test/check command and collects pass/fail + output.
 */

import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT = 60_000; // 60 seconds
const MAX_OUTPUT = 20_000;

/**
 * Run a verification command.
 * @param {string} command - Shell command to run
 * @param {string} cwd - Working directory
 * @returns {Promise<{ passed: boolean, command: string, output: string, exitCode: number }>}
 */
export async function verify(command, cwd) {
	return new Promise((resolve) => {
		execFile(
			'/bin/sh',
			['-c', command],
			{
				cwd,
				timeout: DEFAULT_TIMEOUT,
				maxBuffer: MAX_OUTPUT * 2,
				env: { ...process.env, PATH: process.env.PATH },
			},
			(err, stdout, stderr) => {
				const exitCode = err?.code ?? 0;
				const code = typeof exitCode === 'number' ? exitCode : 1;
				const output = [stdout, stderr]
					.filter(Boolean)
					.join('\n')
					.slice(0, MAX_OUTPUT);

				resolve({
					passed: code === 0,
					command,
					output,
					exitCode: code,
				});
			},
		);
	});
}
