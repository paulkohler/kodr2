/**
 * Shared shell command runner.
 *
 * Spawns `/bin/sh -c <command>` with a curated environment, a generous
 * timeout, and bounded output. The single execution path for both the
 * run_command tool and verification, so the two cannot diverge.
 *
 * Never throws: a non-zero exit, a signal (including the SIGTERM sent on
 * timeout), or a buffer overflow are all reported as a non-zero exitCode.
 */

import { execFile } from 'node:child_process';
import { buildEnv } from './env.mjs';

// Local models are slow and may drive long builds or test suites, so the
// default is generous. Callers can shorten it per command.
export const DEFAULT_TIMEOUT = 600_000; // 10 minutes
export const DEFAULT_MAX_OUTPUT = 50_000; // characters per stream

/**
 * Run a shell command and resolve with its captured output.
 * @param {string} command - Shell command to run
 * @param {string} cwd - Working directory
 * @param {object} [options]
 * @param {number} [options.timeout] - Timeout in ms (default 10 minutes)
 * @param {number} [options.maxOutput] - Max characters kept per stream
 * @param {Record<string, string>} [options.env] - Child environment
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runShell(command, cwd, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const env = options.env ?? buildEnv();

  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout, maxBuffer: maxOutput * 2, env },
      (err, stdout, stderr) => {
        resolve({
          stdout: truncate(stdout || '', maxOutput),
          stderr: truncate(stderr || '', maxOutput),
          exitCode: exitCodeFrom(err),
        });
      },
    );
  });
}

/**
 * Normalize an execFile error to a numeric exit code. A numeric `code` is the
 * process exit status; anything else (a signal name, the maxBuffer error
 * string, a null code on timeout) is reported as a generic failure.
 */
function exitCodeFrom(err) {
  if (!err) {
    return 0;
  }
  if (typeof err.code === 'number') {
    return err.code;
  }
  return 1;
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated]`;
}
