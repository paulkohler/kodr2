/**
 * Verification runner.
 * Runs a test/check command and collects pass/fail + output.
 */

import { execFile } from 'node:child_process';
import { buildEnv } from './env.mjs';

const DEFAULT_TIMEOUT = 60_000; // 60 seconds
const MAX_OUTPUT = 20_000;

/**
 * Run a verification command.
 * @param {string} command - Shell command to run
 * @param {string} cwd - Working directory
 * @returns {Promise<{ passed: boolean, command: string, output: string, exitCode: number }>}
 */
export async function verify(command, cwd, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? MAX_OUTPUT;
  const env = options.env ?? buildEnv();
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd,
        timeout,
        maxBuffer: maxOutput * 2,
        env,
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err && typeof err.code === 'number') {
          code = err.code;
        }
        if (err && typeof err.code !== 'number') {
          code = 1;
        }
        const output = [stdout, stderr]
          .filter(Boolean)
          .join('\n')
          .slice(0, maxOutput);

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
