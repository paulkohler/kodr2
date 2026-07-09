/**
 * Stamp package.json's version patch number from the commit count on main.
 *
 * Keeps the `major.minor` prefix already in package.json and sets the patch
 * to the number of commits reachable from HEAD, e.g. `0.2` + 94 -> `0.2.94`.
 * Run with `--check` to verify without writing (exit 1 on mismatch).
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const pkgUrl = new URL('../package.json', import.meta.url);
const raw = await readFile(pkgUrl, 'utf8');
const pkg = JSON.parse(raw);

const [major, minor] = pkg.version.split('.');
const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const next = `${major}.${minor}.${count}`;

const check = process.argv.includes('--check');

if (check) {
  if (pkg.version !== next) {
    process.stderr.write(
      `package.json version ${pkg.version} does not match commit count ${next}\n`,
    );
    process.exitCode = 1;
  }
} else if (pkg.version === next) {
  process.stdout.write(`version already ${next}\n`);
} else {
  const updated = raw.replace(
    /("version":\s*")[^"]*(")/,
    `$1${next}$2`,
  );
  await writeFile(pkgUrl, updated);
  process.stdout.write(`version ${pkg.version} -> ${next}\n`);
}
