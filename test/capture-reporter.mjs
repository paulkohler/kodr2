/**
 * A capturing reporter for unit tests: records every reporter call, in order,
 * as { type, ...payload } entries. Total like every reporter (built from
 * REPORTER_METHODS), so it can stand in anywhere a real reporter is expected
 * and let a test assert the exact event sequence a scripted run produced.
 *
 * Not a *.test.mjs file, so `node --test test/*.test.mjs` treats it as a plain
 * helper module rather than a test file.
 */

import { REPORTER_METHODS } from '../src/reporter.mjs';

/**
 * @returns {{ reporter: object, events: Array<object> }}
 */
export function createCaptureReporter() {
  const events = [];
  const reporter = {};
  for (const type of REPORTER_METHODS) {
    reporter[type] = (payload) => {
      events.push({ type, payload });
    };
  }
  return { reporter, events };
}

/**
 * A minimal in-memory writable, matching the tiny surface the terminal/json
 * reporters use (write returns true). `.text()` returns everything written.
 * @returns {{ write: (s: string) => boolean, text: () => string }}
 */
export function createFakeStream() {
  const chunks = [];
  return {
    write(s) {
      chunks.push(s);
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}
