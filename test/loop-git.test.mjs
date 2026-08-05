import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  commitAll,
  hasCommits,
  isGitRepo,
  isTracked,
  park,
  registerExcludes,
  wipeResetPaths,
} from '../src/loop-git.mjs';
import {
  createLoopRepo,
  gitStatus,
  readRepoFile,
  repoFileExists,
} from './loop-fixtures.mjs';

let cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
});

async function repoFixture(options = {}) {
  const ctx = await createLoopRepo({ tasks: ['do the thing'], ...options });
  cleanups.push(ctx.cleanup);
  return ctx;
}

describe('isGitRepo / hasCommits', () => {
  it('isGitRepo is true inside a git repo', async () => {
    const { repo } = await repoFixture();
    assert.equal(await isGitRepo(repo), true);
  });

  it('isGitRepo is false outside a git repo', async () => {
    const { root } = await repoFixture();
    assert.equal(await isGitRepo(root), false);
  });

  it('hasCommits is true after an initial commit', async () => {
    const { repo } = await repoFixture();
    assert.equal(await hasCommits(repo), true);
  });

  it('hasCommits is false in a repo with no commits', async () => {
    const { repo } = await repoFixture({ noInitialCommit: true });
    assert.equal(await hasCommits(repo), false);
  });
});

describe('commitAll', () => {
  it('stages and commits every change with the given message', async () => {
    const { repo } = await repoFixture();
    await writeFile(join(repo, 'new-file.txt'), 'content\n');
    const result = await commitAll(repo, 'kodr: do the thing');
    assert.equal(result.ok, true);
    assert.ok(result.sha);
    assert.equal(gitStatus(repo), '');
    const log = await readRepoFile(repo, '.git/COMMIT_EDITMSG');
    assert.match(log, /kodr: do the thing/);
  });

  it('reports no changes to commit when the tree is clean', async () => {
    const { repo } = await repoFixture();
    const result = await commitAll(repo, 'kodr: nothing changed');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no changes to commit');
  });
});

describe('wipeResetPaths', () => {
  it('refuses ".", "..", ".git", an absolute path, and traversal', async () => {
    const { repo } = await repoFixture();
    const result = await wipeResetPaths(repo, [
      '.',
      '..',
      '.git',
      '/etc',
      '../outside',
    ]);
    assert.deepEqual(result.wiped, []);
    assert.deepEqual(result.refused, ['.', '..', '.git', '/etc', '../outside']);
  });

  it('wipes an existing directory and recreates it empty', async () => {
    const { repo } = await repoFixture({ untracked: { 'data/db.txt': 'x' } });
    const result = await wipeResetPaths(repo, ['data']);
    assert.deepEqual(result.wiped, ['data']);
    assert.equal(repoFileExists(repo, 'data'), true);
    assert.equal(repoFileExists(repo, 'data/db.txt'), false);
  });

  it('wipes a single untracked file outright', async () => {
    const { repo } = await repoFixture({ untracked: { 'cache.txt': 'x' } });
    const result = await wipeResetPaths(repo, ['cache.txt']);
    assert.deepEqual(result.wiped, ['cache.txt']);
    assert.equal(repoFileExists(repo, 'cache.txt'), false);
  });

  it('leaves a path that does not exist neither wiped nor refused', async () => {
    const { repo } = await repoFixture();
    const result = await wipeResetPaths(repo, ['nowhere']);
    assert.deepEqual(result.wiped, []);
    assert.deepEqual(result.refused, []);
  });

  it('refuses every spelling that resolves to .git, not just the literal string', async () => {
    const { repo } = await repoFixture();
    const result = await wipeResetPaths(repo, [
      '.git/',
      './.git',
      'data/../.git',
      '.GIT',
    ]);
    assert.deepEqual(result.wiped, []);
    assert.deepEqual(result.refused, [
      '.git/',
      './.git',
      'data/../.git',
      '.GIT',
    ]);
    // The repo must still be intact -- this is the actual regression case,
    // not just a check on the returned lists.
    assert.equal(await hasCommits(repo), true);
  });

  it('refuses an absolute path even when it resolves inside cwd', async () => {
    const { repo } = await repoFixture({ untracked: { 'data/db.txt': 'x' } });
    const result = await wipeResetPaths(repo, [join(repo, 'data')]);
    assert.deepEqual(result.wiped, []);
    assert.deepEqual(result.refused, [join(repo, 'data')]);
    assert.equal(repoFileExists(repo, 'data/db.txt'), true);
  });

  it('refuses a path git tracks anything under, rather than wiping tracked history', async () => {
    const { repo } = await repoFixture({ files: { 'src/a.js': 'x' } });
    const result = await wipeResetPaths(repo, ['src']);
    assert.deepEqual(result.wiped, []);
    assert.deepEqual(result.refused, ['src']);
    assert.equal(repoFileExists(repo, 'src/a.js'), true);
  });
});

describe('isTracked', () => {
  it('is true for a tracked file', async () => {
    const { repo } = await repoFixture({ files: { 'src/a.js': 'x' } });
    assert.equal(await isTracked(repo, 'src/a.js'), true);
  });

  it('is true for a directory holding tracked files', async () => {
    const { repo } = await repoFixture({ files: { 'src/a.js': 'x' } });
    assert.equal(await isTracked(repo, 'src'), true);
  });

  it('is false for an untracked path', async () => {
    const { repo } = await repoFixture({ untracked: { 'data/db.txt': 'x' } });
    assert.equal(await isTracked(repo, 'data'), false);
  });
});

describe('park', () => {
  it('discards tracked changes and removes untracked debris', async () => {
    const { repo } = await repoFixture();
    await writeFile(join(repo, 'README.md'), 'mutated\n');
    await writeFile(join(repo, 'debris.txt'), 'stray file\n');
    const result = await park(repo, []);
    assert.equal(result.ok, true);
    assert.equal(await readRepoFile(repo, 'README.md'), '# fixture\n');
    assert.equal(repoFileExists(repo, 'debris.txt'), false);
  });

  it('leaves a gitignored path alone -- that is resetPaths, not clean -fd', async () => {
    const { repo } = await repoFixture({
      gitignore: 'data/\n',
      untracked: { 'data/db.txt': 'x' },
    });
    const result = await park(repo, []);
    assert.equal(result.ok, true);
    assert.equal(repoFileExists(repo, 'data/db.txt'), true);
  });

  it('wipes configured resetPaths on top of the git reset/clean', async () => {
    const { repo } = await repoFixture({
      gitignore: 'data/\n',
      untracked: { 'data/db.txt': 'x' },
    });
    const result = await park(repo, ['data']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.wiped, ['data']);
    assert.equal(repoFileExists(repo, 'data'), true);
    assert.equal(repoFileExists(repo, 'data/db.txt'), false);
  });

  it('reports refused resetPaths entries without failing the park', async () => {
    const { repo } = await repoFixture();
    const result = await park(repo, ['..']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.refused, ['..']);
  });
});

describe('registerExcludes', () => {
  it('adds entries to .git/info/exclude', async () => {
    const { repo } = await repoFixture();
    const result = await registerExcludes(repo, ['.kodr/', 'loop.log']);
    assert.equal(result.ok, true);
    const exclude = await readFile(join(repo, '.git/info/exclude'), 'utf8');
    assert.match(exclude, /^\.kodr\/$/m);
    assert.match(exclude, /^loop\.log$/m);
  });

  it('is idempotent -- an already-present entry is not duplicated', async () => {
    const { repo } = await repoFixture();
    await registerExcludes(repo, ['.kodr/']);
    await registerExcludes(repo, ['.kodr/']);
    const exclude = await readFile(join(repo, '.git/info/exclude'), 'utf8');
    const matches = exclude.match(/^\.kodr\/$/gm) || [];
    assert.equal(matches.length, 1);
  });
});
