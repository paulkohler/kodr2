import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { commitFiles, commitTimeoutMs, isGitRepo } from '../src/commit.mjs';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`),
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-commit-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function initRepo(dir) {
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@test.com']);
  await git(dir, ['config', 'user.name', 'test']);
}

describe('isGitRepo', () => {
  it('returns true inside a real git work tree', async () => {
    await initRepo(tmpDir);
    assert.equal(await isGitRepo(tmpDir), true);
  });

  it('returns false outside a git work tree', async () => {
    assert.equal(await isGitRepo(tmpDir), false);
  });
});

describe('commitFiles', () => {
  it('commits exactly the given files and returns the new commit sha', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.mjs'), 'export const a = 1;\n');
    await writeFile(join(tmpDir, 'untouched.mjs'), 'export const b = 1;\n');

    const result = await commitFiles({
      cwd: tmpDir,
      files: ['a.mjs'],
      message: 'kodr: raw build output',
    });

    assert.equal(result.committed, true);
    assert.match(result.sha, /^[0-9a-f]{40}$/);

    const log = await git(tmpDir, ['log', '--format=%s']);
    assert.equal(log, 'kodr: raw build output');

    // untouched.mjs was never added, so it's still untracked.
    const status = await git(tmpDir, ['status', '--porcelain']);
    assert.match(status, /\?\? untouched\.mjs/);
  });

  it('returns { committed: false, reason } when files is empty', async () => {
    await initRepo(tmpDir);
    const result = await commitFiles({ cwd: tmpDir, files: [], message: 'x' });
    assert.deepEqual(result, {
      committed: false,
      reason: 'no files to commit',
    });
  });

  it('returns { committed: false, reason } when the given files produce no actual diff', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.mjs'), 'export const a = 1;\n');
    await git(tmpDir, ['add', 'a.mjs']);
    await git(tmpDir, ['commit', '-m', 'initial']);

    // a.mjs is already committed with this exact content -- nothing changed.
    const result = await commitFiles({
      cwd: tmpDir,
      files: ['a.mjs'],
      message: 'kodr: raw build output',
    });

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'no changes to commit');
  });

  it('never runs git add -A -- only the files it was given', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.mjs'), 'export const a = 1;\n');
    await writeFile(
      join(tmpDir, 'unrelated-dirty-file.mjs'),
      'export const c = 1;\n',
    );

    await commitFiles({
      cwd: tmpDir,
      files: ['a.mjs'],
      message: 'kodr: raw build output',
    });

    // The unrelated file the user had sitting in their working tree must
    // never have been swept into the commit.
    const status = await git(tmpDir, ['status', '--porcelain']);
    assert.match(status, /\?\? unrelated-dirty-file\.mjs/);
    const filesInCommit = await git(tmpDir, [
      'show',
      '--name-only',
      '--format=',
    ]);
    assert.equal(filesInCommit, 'a.mjs');
  });

  it('returns { committed: false, error } without throwing when git commit fails (e.g. a rejected hook)', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.mjs'), 'export const a = 1;\n');
    const hooksDir = join(tmpDir, '.git', 'hooks');
    await writeFile(
      join(hooksDir, 'pre-commit'),
      '#!/bin/sh\necho "rejected by pre-commit hook" >&2\nexit 1\n',
      { mode: 0o755 },
    );

    const result = await commitFiles({
      cwd: tmpDir,
      files: ['a.mjs'],
      message: 'kodr: raw build output',
    });

    assert.equal(result.committed, false);
    assert.match(result.error, /git commit failed/);
  });

  it('does not pass --no-verify to git commit', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.mjs'), 'export const a = 1;\n');
    const hooksDir = join(tmpDir, '.git', 'hooks');
    await writeFile(
      join(hooksDir, 'pre-commit'),
      '#!/bin/sh\necho ran > pre-commit-ran\nexit 0\n',
      { mode: 0o755 },
    );

    await commitFiles({
      cwd: tmpDir,
      files: ['a.mjs'],
      message: 'kodr: raw build output',
    });

    const { readFile } = await import('node:fs/promises');
    const hookRan = await readFile(join(tmpDir, 'pre-commit-ran'), 'utf8').then(
      () => true,
      () => false,
    );
    assert.equal(hookRan, true, 'expected the pre-commit hook to have run');
  });

  it('correctly stages a file whose path looks like a git flag or contains spaces', async () => {
    await initRepo(tmpDir);
    const flagLikeName = '--upload-pack=x.mjs';
    const spacedName = 'has spaces.mjs';
    await writeFile(join(tmpDir, flagLikeName), 'export const a = 1;\n');
    await writeFile(join(tmpDir, spacedName), 'export const b = 1;\n');

    const result = await commitFiles({
      cwd: tmpDir,
      files: [flagLikeName, spacedName],
      message: 'kodr: raw build output',
    });

    assert.equal(result.committed, true);
    const filesInCommit = await git(tmpDir, [
      'show',
      '--name-only',
      '--format=',
    ]);
    assert.deepEqual(
      filesInCommit.split('\n').sort(),
      [flagLikeName, spacedName].sort(),
    );
  });
});

describe('commitTimeoutMs', () => {
  const envKey = 'KODR_COMMIT_TIMEOUT_MS';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('prefers an explicit option', () => {
    process.env[envKey] = '5000';
    assert.equal(commitTimeoutMs(1234), 1234);
  });

  it('falls back to KODR_COMMIT_TIMEOUT_MS', () => {
    process.env[envKey] = '5000';
    assert.equal(commitTimeoutMs(undefined), 5000);
  });

  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(commitTimeoutMs(undefined), 30_000);
  });
});
