/**
 * Preflight check that the external `tsc` binary is reachable.
 *
 * TypeScript's compiler is used in --noEmit/checkJs mode as a type checker
 * for this repo's JSDoc-typed .mjs files, but is deliberately kept out of
 * package.json (see the zero-dependency guard) -- so a missing binary
 * otherwise fails as a bare `sh: 1: tsc: not found` with no indication of
 * what to do about it. This turns that into a one-line, actionable message
 * before the real command runs.
 */

import { execFileSync } from 'node:child_process';

const INSTALL_HINT = [
  'tsc binary not found on PATH.',
  '',
  'TypeScript is a required developer tool (JSDoc type checking) but is not',
  'an npm dependency (see AGENTS.md). Install it globally, e.g.:',
  '  npm install -g typescript',
  'or run commands ad hoc with:',
  '  npx typescript@latest tsc --noEmit -p jsconfig.json',
  '',
].join('\n');

/**
 * @param {function} [probe] - Overridable for tests; defaults to running
 *   `tsc --version`.
 * @returns {boolean} Whether the tsc binary is reachable
 */
export function isTypeScriptAvailable(probe = defaultProbe) {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}

function defaultProbe() {
  execFileSync('tsc', ['--version'], { stdio: 'ignore' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!isTypeScriptAvailable()) {
    process.stderr.write(INSTALL_HINT);
    process.exitCode = 1;
  }
}
