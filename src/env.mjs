/**
 * Environment allowlist for child processes.
 *
 * Model-supplied commands (run_command) and verification commands run with a
 * minimal, curated environment — never the harness's full process.env, which
 * may carry secrets. Extra variables can be allowed by name (see --env).
 */

// A small default set: enough to find and run common tooling, nothing more.
const DEFAULT_ENV_VARS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
];

/**
 * Build the environment passed to child processes.
 * Always includes the default allowlist; adds any extra variable names that
 * are actually present in process.env.
 * @param {string[]} [extraNames] - Additional variable names to pass through
 * @returns {Record<string, string>}
 */
export function buildEnv(extraNames = []) {
  const env = {};
  for (const name of [...DEFAULT_ENV_VARS, ...extraNames]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Parse a comma-separated list of variable names (the --env value).
 * Trims whitespace, drops empties, and de-duplicates.
 * @param {string} csv
 * @returns {string[]}
 */
export function parseEnvNames(csv) {
  if (!csv) {
    return [];
  }
  const names = [];
  for (const part of csv.split(',')) {
    const name = part.trim();
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}
