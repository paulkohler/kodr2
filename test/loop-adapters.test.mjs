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
import { createNullReporter } from '../src/reporter.mjs';
import {
  allCommittedFiles,
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
  const edits = {
    rewording: '# Tasks\n\n- [ ] renamed\n- [ ] beta\n',
    insertion: '# Tasks\n\n- [ ] inserted\n- [ ] alpha\n- [ ] beta\n',
    removal: '# Tasks\n\n- [ ] beta\n',
    reordering: '# Tasks\n\n- [ ] beta\n- [ ] alpha\n',
  };
  for (const [edit, content] of Object.entries(edits)) {
    it(`refuses unchecked ${edit} without committing or marking another task`, async () => {
      const repo = await repoWith(['alpha', 'beta']);
      const result = await drive(repo, async () => {
        writeFileSync(join(repo, 'TASKS.md'), content);
        writeFileSync(join(repo, 'work.mjs'), 'export const work = true;\n');
        return greenResult(['work.mjs', 'TASKS.md']);
      });

      assert.equal(result.reason, 'mark-failed');
      assert.equal(result.green, 0);
      assert.equal(readRepoFile(repo, 'TASKS.md'), content);
      assert.deepEqual(commitSubjects(repo), ['init']);
      assert.equal(readRepoFile(repo, 'work.mjs'), 'export const work = true;\n');
    });
  }

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

  it('reports the checklist position of the task nextTask returned', async () => {
    const repo = await repoWith(['alpha', 'beta', 'gamma']);
    const checklist = checklistAdapter(join(repo, 'TASKS.md'));

    assert.equal(checklist.progress(), null, 'nothing read yet');
    assert.equal(await checklist.nextTask(), 'alpha');
    assert.deepEqual(checklist.progress(), { index: 1, total: 3 });

    assert.equal((await checklist.markTask('x')).ok, true);
    assert.equal(await checklist.nextTask(), 'beta');
    // Position in the file, not the loop's iteration count: a resumed run
    // starting here has to say 2 of 3, not 1 of 3 (BACKLOG #13).
    assert.deepEqual(checklist.progress(), { index: 2, total: 3 });

    assert.equal((await checklist.markTask('x')).ok, true);
    assert.equal(await checklist.nextTask(), 'gamma');
    assert.equal((await checklist.markTask('x')).ok, true);
    assert.equal(await checklist.nextTask(), null);
    assert.equal(checklist.progress(), null, 'forgotten with the backlog');
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

describe('a model that ticks its own box (BACKLOG #12)', () => {
  /**
   * A green attempt that also marks its own line done, which is what a
   * capable model does once it has read the `- [x]` convention off the lines
   * above: "Marking the phase complete in TASKS.md (consistent with how prior
   * phases were recorded)". Before #12 this stopped the whole loop and the
   * work it had just verified was never committed.
   */
  function tidyModel(repo, task) {
    return async () => {
      writeFileSync(join(repo, 'done.mjs'), 'export const done = true;\n');
      const tasks = readFileSync(join(repo, 'TASKS.md'), 'utf8');
      writeFileSync(
        join(repo, 'TASKS.md'),
        tasks.replace(`- [ ] ${task}`, `- [x] ${task}`),
      );
      return greenResult(['done.mjs', 'TASKS.md']);
    };
  }

  it('commits the green work instead of stopping with mark-failed', async () => {
    const repo = await repoWith(['alpha', 'beta']);
    // maxTasks 0 disables the cap, so the loop runs the checklist out and the
    // reason proves it carried on past the self-ticked task rather than
    // stopping on it.
    const result = await drive(repo, tidyModel(repo, 'alpha'), {
      maxTasks: 0,
    });

    assert.equal(result.reason, 'backlog-empty');
    assert.equal(result.green, 2);
    assert.deepEqual(commitSubjects(repo), [
      'kodr: beta',
      'kodr: alpha',
      'init',
    ]);
    assert.ok(
      allCommittedFiles(repo).includes('done.mjs'),
      'the verified work has to reach a commit -- not committing it is the whole cost of #12',
    );
    assert.equal(gitStatus(repo), '', 'nothing left uncommitted');
  });

  it('records that the attempt marked the line, rather than staying silent', async () => {
    const repo = await repoWith(['alpha']);
    const notices = [];
    const result = await drive(repo, tidyModel(repo, 'alpha'), {
      reporter: {
        ...createNullReporter(),
        notice: (text) => notices.push(text),
      },
    });

    assert.equal(result.tasks[0].markedByAttempt, true);
    assert.ok(
      notices.some((n) => /already ticked this line itself/.test(n)),
      `expected a notice about the self-tick, got ${JSON.stringify(notices)}`,
    );
  });

  it('still refuses when the attempt rewrote the line instead of ticking it', async () => {
    // The #8 guard has to keep its teeth: a reworded line means the index no
    // longer addresses the task that ran, and nothing proves otherwise.
    const repo = await repoWith(['alpha', 'beta']);
    const result = await drive(repo, async () => {
      writeFileSync(join(repo, 'done.mjs'), 'export const done = true;\n');
      writeFileSync(
        join(repo, 'TASKS.md'),
        '- [x] something else\n- [ ] beta\n',
      );
      return greenResult(['done.mjs', 'TASKS.md']);
    });

    assert.equal(result.reason, 'mark-failed');
    assert.equal(result.green, 0);
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

describe('an all-errored task over a real repo (BACKLOG #10)', () => {
  it('rewinds the tree but leaves the checklist file unchecked', async () => {
    // The composition the fakes in loop.test.mjs cannot reach: a real
    // TASKS.md on disk has to still read "- [ ]" afterwards, because that is
    // what lets a rerun pick the task up. A mark here would retire it.
    const repo = await repoWith(['alpha', 'beta']);
    const before = git(repo, ['rev-parse', 'HEAD']).trim();

    const result = await runLoop({
      checklist: checklistAdapter(join(repo, 'TASKS.md')),
      buildTask: async () => {
        // A half-finished attempt leaves debris, then the provider dies.
        writeFileSync(join(repo, 'scratch.mjs'), 'export const partial = 1;\n');
        return {
          stoppedReason: 'error',
          noOpCompletion: false,
          verification: null,
          filesChanged: ['scratch.mjs'],
          error: { message: 'HTTP 500', name: 'Error', stack: '' },
          messages: [],
          usage: { prompt: 1, completion: 1, cost: 0 },
          retries: 0,
        };
      },
      buildGoal: async () => {
        throw new Error('unused');
      },
      git: gitAdapter(repo),
      maxAttempts: 2,
      // The backoff between errored attempts is real time; loop.test.mjs
      // covers it against a fake clock, so skip the 5s wait here.
      retryBackoffMs: 0,
    });

    assert.equal(result.reason, 'attempts-errored');
    assert.equal(result.parked, 0);

    const tasks = readRepoFile(repo, 'TASKS.md');
    assert.match(tasks, /- \[ \] alpha/);
    assert.match(tasks, /- \[ \] beta/);

    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), before, 'no commit');
    assert.equal(gitStatus(repo), '', 'the debris should be swept');
    assert.deepEqual(commitSubjects(repo), ['init']);
  });
});
