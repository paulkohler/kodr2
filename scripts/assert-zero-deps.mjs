/**
 * Guard the repo's zero-dependency contract.
 *
 * Kodr may use externally installed developer tools such as Biome, but the
 * package itself must not declare runtime or development npm dependencies.
 */

import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

const fields = ['dependencies', 'devDependencies'];
const violations = fields.filter((field) => hasEntries(pkg[field]));

if (violations.length > 0) {
  for (const field of violations) {
    const names = Object.keys(pkg[field]).sort().join(', ');
    process.stderr.write(`package.json ${field} must be empty: ${names}\n`);
  }
  process.stderr.write(
    'Kodr is zero-dependency. Use externally installed tools or document an explicit exception.\n',
  );
  process.exitCode = 1;
}

function hasEntries(value) {
  return value && typeof value === 'object' && Object.keys(value).length > 0;
}
