/**
 * Environment allowlist for child processes.
 *
 * Model-supplied commands (run_command) and verification commands run with a
 * minimal, curated environment — never the harness's full process.env, which
 * may carry secrets. Extra variables can be allowed by name (see --env).
 */

// A small default set: enough to find and run common tooling, nothing more.
// The GIT_* identity pair is here because Kodr commits as part of normal
// operation (kodr loop commits per task, see specs/loop.yaml). git refuses to
// commit without an identity, and in an environment with no ~/.gitconfig --
// a container, a sandbox, CI -- the only way to supply one is the
// environment. Without these the loop does all the work and then dies with
// "Author identity unknown" on its first commit. They are identity, not
// secrets, so passing them by default costs nothing the allowlist exists to
// protect.
const DEFAULT_ENV_VARS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
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
