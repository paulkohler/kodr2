/**
 * Local install: writes a shell shim that execs this checkout's
 * bin/kodr.mjs, so `kodr` resolves without an npm/global install.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_DIR = () => join(process.env.HOME, '.local', 'bin');
const DEFAULT_NAME = 'kodr';

/**
 * Write a shim script pointing at this checkout's CLI entry point.
 * @param {string} cwd - Repo checkout root
 * @param {object} [options]
 * @param {string} [options.dir] - Directory to write the shim into (default `~/.local/bin`)
 * @param {string} [options.name] - Shim filename (default `kodr`)
 * @returns {Promise<{path: string}>}
 */
export async function installLocal(cwd, options = {}) {
  const dir = options.dir || DEFAULT_DIR();
  const name = options.name || DEFAULT_NAME;
  const target = join(dir, name);
  const entry = resolve(cwd, 'bin', 'kodr.mjs');
  const shim = `#!/bin/sh\nexec node "${entry}" "$@"\n`;

  await mkdir(dir, { recursive: true });
  await writeFile(target, shim, 'utf8');
  await chmod(target, 0o755);

  return { path: target };
}
