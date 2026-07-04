/**
 * Preflight check that the external `biome` binary is reachable.
 *
 * Biome is a required developer tool (formatting/linting) but is
 * deliberately kept out of package.json (see the zero-dependency guard) --
 * so a missing binary otherwise fails as a bare `sh: 1: biome: not found`
 * with no indication of what to do about it. This turns that into a
 * one-line, actionable message before the real command runs.
 */

import { execFileSync } from 'node:child_process';

const INSTALL_HINT = [
  'biome binary not found on PATH.',
  '',
  'Biome is a required developer tool but is not an npm dependency (see AGENTS.md).',
  'Install it globally, e.g.:',
  '  npm install -g @biomejs/biome',
  'or run commands ad hoc with:',
  '  npx @biomejs/biome@latest <command>',
  '',
].join('\n');

/**
 * @param {function} [probe] - Overridable for tests; defaults to running
 *   `biome --version`.
 * @returns {boolean} Whether the biome binary is reachable
 */
export function isBiomeAvailable(probe = defaultProbe) {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}

function defaultProbe() {
  execFileSync('biome', ['--version'], { stdio: 'ignore' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!isBiomeAvailable()) {
    process.stderr.write(INSTALL_HINT);
    process.exitCode = 1;
  }
}
