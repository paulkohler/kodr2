/**
 * The #8 regression, as a composition.
 *
 * test/loop.test.mjs proves runLoop hands park the pre-attempt sha, against a
 * fake git. test/loop-git.test.mjs proves a real park(cwd, paths, sha)
 * discards a model commit, against a fake loop. Neither can fail if the
 * wiring between them regresses -- which is exactly where #8 lived. This file
 * drives the real adapters over a real git repo with only the model faked, so
 * the whole chain is under test: readNextTask's line index -> the attempt ->
 * headSha -> park's rewind -> markTaskAt's line -> the park commit.
 *
 * The last case is the control: it rebuilds the git collaborator without
 * headSha and asserts #8 comes back. A regression test for a silent bug is
 * worth nothing until you have watched it fail.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runLoop } from '../src/loop.mjs';
import { checklistAdapter, gitAdapter } from '../src/loop-adapters.mjs';
import {
  commitSubjects,
  createLoopRepo,
  filesInHead,
  gitStatus,
  readRepoFile,
} from './loop-fixtures.mjs';

/** @type {Array<() => Promise<void>>} */
const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup();
  }
});

async function repoWith(tasks) {
  const ctx = await createLoopRepo({ tasks });
  cleanups.push(ctx.cleanup);
  return ctx.repo;
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/**
 * A model that writes a file, commits it itself, and fails the gate. The
 * self-commit is the #8 trigger: a bare `git reset --hard` leaves it in
 * history, so the park keeps work the gate rejected.
 */
function committingModel(repo, file = 'half-done.mjs') {
  return async () => {
    writeFileSync(join(repo, file), 'export const halfDone = true;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'wip: model committed its own work']);
    return redResult();
  };
}

function redResult() {
  return {
    stoppedReason: 'complete',
    noOpCompletion: false,
    verification: { passed: false },
    filesChanged: ['half-done.mjs'],
    messages: [],
    usage: { prompt: 10, completion: 5, cost: 0 },
    retries: 0,
  };
}

function greenResult(filesChanged) {
  return {
    stoppedReason: 'complete',
    noOpCompletion: false,
    verification: { passed: true },
    filesChanged,
    messages: [],
    usage: { prompt: 10, completion: 5, cost: 0 },
    retries: 0,
  };
}

/** Drive runLoop over a real repo with the real adapters. */
function drive(repo, buildTask, overrides = {}) {
  return runLoop({
    checklist: checklistAdapter(join(repo, 'TASKS.md')),
    buildTask,
    buildGoal: async () => {
      throw new Error('no GOAL: task in this fixture');
    },
    git: gitAdapter(repo),
    maxAttempts: 1,
    maxTasks: 1,
    ...overrides,
  });
}

describe('loop adapters over a real repo (BACKLOG #8)', () => {
  it('discards a commit the model made during a parked attempt', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    const result = await drive(repo, committingModel(repo));

    assert.equal(result.parked, 1);
    const subjects = commitSubjects(repo);
    assert.ok(
      !subjects.includes('wip: model committed its own work'),
      `the model's commit survived the park: ${JSON.stringify(subjects)}`,
    );
    assert.deepEqual(subjects, ['kodr: park alpha', 'init']);
  });

  it('marks the line the attempt took, not the first unchecked line', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    await drive(repo, committingModel(repo));

    const tasks = readRepoFile(repo, 'TASKS.md');
    assert.match(tasks, /- \[!\] alpha/);
    assert.match(tasks, /- \[ \] beta/);
  });

  it('leaves history at the pre-attempt sha plus exactly one park commit', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    const before = git(repo, ['rev-parse', 'HEAD']).trim();
    await drive(repo, committingModel(repo));

    assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '2');
    assert.equal(
      git(repo, ['rev-parse', 'HEAD~1']).trim(),
      before,
      'the park commit should sit directly on the pre-attempt sha',
    );
  });

  it('commits only the checklist on the park', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    await drive(repo, committingModel(repo));

    assert.deepEqual(filesInHead(repo), ['TASKS.md']);
    assert.equal(gitStatus(repo), '', 'the tree should be clean after a park');
  });

  it('removes the file the model committed from the working tree', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    await drive(repo, committingModel(repo));

    assert.throws(
      () => readFileSync(join(repo, 'half-done.mjs'), 'utf8'),
      'the rejected work should not survive the park',
    );
  });

  it('marks the right line even when the model edited the checklist', async () => {
    // The model reorders the checklist mid-attempt, so "the first unchecked
    // line" and "the line this task came from" disagree. The park rewinds the
    // edit, and the mark must still land on alpha.
    const repo = await repoWith(['alpha', 'beta']);
    const result = await drive(repo, async () => {
      writeFileSync(
        join(repo, 'TASKS.md'),
        '# Tasks\n\n- [ ] beta\n- [ ] alpha\n',
      );
      return redResult();
    });

    assert.equal(result.parked, 1);
    const tasks = readRepoFile(repo, 'TASKS.md');
    assert.match(tasks, /- \[!\] alpha/);
    assert.match(tasks, /- \[ \] beta/);
  });

  it('keeps the model work on the green path rather than rewinding it', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    const result = await drive(repo, async () => {
      writeFileSync(join(repo, 'feature.mjs'), 'export const ok = true;\n');
      return greenResult(['feature.mjs']);
    });

    assert.equal(result.green, 1);
    assert.deepEqual(commitSubjects(repo), ['kodr: alpha', 'init']);
    assert.deepEqual(filesInHead(repo).sort(), ['TASKS.md', 'feature.mjs']);
    assert.match(readRepoFile(repo, 'TASKS.md'), /- \[x\] alpha/);
  });
});

describe('checklistAdapter', () => {
  it('refuses a mark with no task behind it rather than marking line 0', async () => {
    const repo = await repoWith(['alpha']);
    const checklist = checklistAdapter(join(repo, 'TASKS.md'));

    const marked = await checklist.markTask('!');
    assert.equal(marked.ok, false);
    assert.match(readRepoFile(repo, 'TASKS.md'), /- \[ \] alpha/);
  });

  it('forgets the pending line once the backlog is empty', async () => {
    const repo = await repoWith(['alpha']);
    const checklist = checklistAdapter(join(repo, 'TASKS.md'));

    assert.equal(await checklist.nextTask(), 'alpha');
    assert.equal((await checklist.markTask('x')).ok, true);
    assert.equal(await checklist.nextTask(), null);

    // The adapter must not still be holding alpha's line: a mark now would
    // overwrite a task that was already settled.
    const marked = await checklist.markTask('!');
    assert.equal(marked.ok, false);
    assert.match(readRepoFile(repo, 'TASKS.md'), /- \[x\] alpha/);
  });

  it('keeps its pending line private to the adapter instance', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    const tasksFile = join(repo, 'TASKS.md');
    const first = checklistAdapter(tasksFile);
    const second = checklistAdapter(tasksFile);

    assert.equal(await first.nextTask(), 'alpha');
    assert.equal(await second.nextTask(), 'alpha');
    assert.equal((await first.markTask('x')).ok, true);
    // second still points at alpha's line, which is no longer unchecked --
    // refused, rather than silently walking onto beta.
    assert.equal((await second.markTask('!')).ok, false);
  });
});

describe('the #8 control -- the regression is detectable', () => {
  it('reproduces #8 when the git collaborator has no headSha', async () => {
    // headSha is optional in runLoop's contract, so a caller that forgets it
    // degrades silently: park falls back to a bare reset and keeps the
    // model's commit. If this case ever goes green, the cases above have
    // stopped proving anything.
    const repo = await repoWith(['alpha', 'beta']);
    const { headSha: _dropped, ...withoutHeadSha } = gitAdapter(repo);

    const result = await runLoop({
      checklist: checklistAdapter(join(repo, 'TASKS.md')),
      buildTask: committingModel(repo),
      buildGoal: async () => {
        throw new Error('unused');
      },
      git: withoutHeadSha,
      maxAttempts: 1,
      maxTasks: 1,
    });

    assert.equal(result.parked, 1);
    assert.ok(
      commitSubjects(repo).includes('wip: model committed its own work'),
      'without headSha the park cannot rewind -- that is the bug, and it should still be reproducible',
    );
  });
});
