import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installLocal } from '../src/install-local.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kodr2-bin-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('local install', () => {
  it('writes an executable shim under the given dir', async () => {
    const result = await installLocal(ROOT, { dir, name: 'kodr-test' });
    assert.equal(result.path, join(dir, 'kodr-test'));
  });

  it('installed shim reports the checkout version', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const result = await installLocal(ROOT, { dir, name: 'kodr-test' });

    const { stdout } = await execFileAsync(result.path, ['--version']);
    assert.match(stdout, new RegExp(pkg.version));
  });

  it('defaults the shim name to kodr', async () => {
    const result = await installLocal(ROOT, { dir });
    assert.equal(result.path, join(dir, 'kodr'));
  });
});
