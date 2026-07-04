/**
 * Optional raw request/response capture for every model chat call, written
 * as a JSONL sidecar file next to the run transcript. Off by default -- see
 * specs/debug-log.yaml.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Whether debug capture is enabled.
 * @param {boolean} [option] - Explicit --debug flag
 * @returns {boolean}
 */
export function debugLogEnabled(option) {
  if (option === true) {
    return true;
  }
  if (option === false) {
    return false;
  }
  const env = process.env.KODR_DEBUG;
  return env === '1' || env === 'true';
}

/**
 * Build an onDebug callback that appends one JSON line per model request to
 * a sidecar file in runsDir, named from the run's start time so it sits
 * alongside the eventual run transcript.
 * @param {string} runsDir
 * @param {Date} startedAt
 * @returns {function(object): void} onDebug(record) -- fire-and-forget; a
 *   write failure is swallowed, never surfaced to the caller
 */
export function createDebugLogger(runsDir, startedAt) {
  const filename = `${startedAt.toISOString().replace(/[:.]/g, '-')}-debug.jsonl`;
  const filePath = join(runsDir, filename);
  let queue = mkdir(runsDir, { recursive: true });

  return function onDebug(record) {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`;
    queue = queue
      .then(() => appendFile(filePath, line, 'utf8'))
      .catch(() => {});
  };
}
