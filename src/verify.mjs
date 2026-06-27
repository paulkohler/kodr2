/**
 * Verification runner.
 * Runs a test/check command via the shared shell runner and reports
 * pass/fail with combined output.
 */

import { runShell } from './shell.mjs';

const DEFAULT_TIMEOUT = 600_000; // 10 minutes
const MAX_OUTPUT = 20_000;

/**
 * Run a verification command.
 * @param {string} command - Shell command to run
 * @param {string} cwd - Working directory
 * @param {object} [options]
 * @param {number} [options.timeout] - Timeout in ms (default 10 minutes)
 * @param {number} [options.maxOutput] - Max characters of combined output
 * @param {Record<string, string>} [options.env] - Child environment
 * @returns {Promise<{ passed: boolean, command: string, output: string, exitCode: number }>}
 */
export async function verify(command, cwd, options = {}) {
  const maxOutput = options.maxOutput ?? MAX_OUTPUT;
  const { stdout, stderr, exitCode } = await runShell(command, cwd, {
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    maxOutput,
    env: options.env,
  });

  const output = [stdout, stderr]
    .filter(Boolean)
    .join('\n')
    .slice(0, maxOutput);

  return {
    passed: exitCode === 0,
    command,
    output,
    exitCode,
  };
}
