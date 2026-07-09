/**
 * Stamp package.json's version patch number from the commit count on main.
 *
 * Keeps the `major.minor` prefix already in package.json and sets the patch
 * to the number of commits reachable from HEAD, e.g. `0.2` + 94 -> `0.2.94`.
 *
 * Because the patch tracks the commit count, the version is inherently one
 * behind right after any commit (stamping is itself a commit). So this is
 * NOT a `pretest` gate -- it would never converge. Instead `version:set`
 * runs at publish time (prepublishOnly) so the published artifact always
 * reflects the true count, and `--check` stays available for manual/CI use.
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Compute the target version from the current version and a commit count.
 * @param {string} current - e.g. "0.2.0"
 * @param {string|number} count - commit count for the patch field
 * @returns {string} e.g. "0.2.94"
 */
export function nextVersion(current, count) {
  const [major, minor] = String(current).split('.');
  return `${major}.${minor}.${count}`;
}

/**
 * Rewrite only the version field in a package.json source string, preserving
 * all other formatting.
 * @param {string} raw - package.json file contents
 * @param {string} version - version to stamp in
 * @returns {string} updated contents
 */
export function stampVersion(raw, version) {
  return raw.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
}

function commitCount(run = defaultRun) {
  return run('git', ['rev-list', '--count', 'HEAD']).trim();
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

async function main() {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const raw = await readFile(pkgUrl, 'utf8');
  const pkg = JSON.parse(raw);
  const next = nextVersion(pkg.version, commitCount());
  const check = process.argv.includes('--check');

  if (check) {
    if (pkg.version !== next) {
      process.stderr.write(
        `package.json version ${pkg.version} does not match commit count ${next}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (pkg.version === next) {
    process.stdout.write(`version already ${next}\n`);
    return;
  }

  await writeFile(pkgUrl, stampVersion(raw, next));
  process.stdout.write(`version ${pkg.version} -> ${next}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
