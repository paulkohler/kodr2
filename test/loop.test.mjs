import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { parseArgs } from '../src/cli.mjs';
import {
  classifyTask,
  goalIsGreen,
  loopGoalMaxAttempts,
  loopMaxAttempts,
  loopMaxLoopCost,
  loopMaxLoopMs,
  loopMaxTasks,
  loopResetPaths,
  loopRetryBackoffMs,
  loopStopOnPark,
  loopTasksFile,
  markFirstTask,
  readNextTask,
  runLoop,
  taskIsGreen,
  validateLoopStart,
} from '../src/loop.mjs';
import { createNullReporter } from '../src/reporter.mjs';

const silentReporter = createNullReporter();

// --- Fakes for the pure loop (runLoop). checklist/buildTask/buildGoal/git
// are injected collaborators, not model mocks -- the loop control is
// exercised with plain return values (goal.test.mjs's own pattern).

function fakeChecklist(tasks) {
  const items = tasks.map((text) => ({ text, mark: ' ' }));
  return {
    items,
    nextTask: async () => {
      const item = items.find((i) => i.mark === ' ');
      return item ? item.text : null;
    },
    markTask: async (mark) => {
      const item = items.find((i) => i.mark === ' ');
      if (item) {
        item.mark = mark;
      }
    },
  };
}

function fakeGit(overrides = {}) {
  const commitCalls = [];
  const parkCalls = [];
  return {
    commitCalls,
    parkCalls,
    commitGreen:
      overrides.commitGreen ||
      (async (message) => {
        commitCalls.push(message);
        return { ok: true, sha: `sha-${commitCalls.length}` };
      }),
    park:
      overrides.park ||
      (async (resetPaths) => {
        parkCalls.push(resetPaths);
        return { ok: true, wiped: [], refused: [] };
      }),
  };
}

function fakeClock() {
  let time = 0;
  const waits = [];
  return {
    waits,
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    },
  };
}

function fakeRunResult(over = {}) {
  return {
    stoppedReason: 'complete',
    noOpCompletion: false,
    verification: null,
    filesChanged: ['a.mjs'],
    messages: [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'done' },
    ],
    usage: { prompt: 10, completion: 5, cost: 0 },
    retries: 0,
    ...over,
  };
}

function fakeGoalResult(over = {}) {
  return {
    met: true,
    reason: 'met',
    attempts: 1,
    verdicts: [],
    usage: { prompt: 20, completion: 10, cost: 0 },
    retries: 0,
    lastResult: { filesChanged: ['b.mjs'], verification: { passed: true } },
    ...over,
  };
}

describe('classifyTask', () => {
  it('routes a "GOAL: " line to kind "goal", prefix stripped', () => {
    assert.deepEqual(classifyTask('GOAL: docs are complete'), {
      kind: 'goal',
      text: 'docs are complete',
    });
  });

  it('routes a plain line to kind "task", unchanged', () => {
    assert.deepEqual(classifyTask('add a test'), {
      kind: 'task',
      text: 'add a test',
    });
  });
});

describe('taskIsGreen', () => {
  it('requires completed AND not noOpCompletion AND verification not failed', () => {
    assert.equal(taskIsGreen(fakeRunResult()), true);
    assert.equal(
      taskIsGreen(fakeRunResult({ stoppedReason: 'tool-limit' })),
      false,
    );
    assert.equal(taskIsGreen(fakeRunResult({ noOpCompletion: true })), false);
    assert.equal(
      taskIsGreen(fakeRunResult({ verification: { passed: false } })),
      false,
    );
  });
});

describe('goalIsGreen', () => {
  it('requires met AND filesChanged non-empty AND verification not failed', () => {
    assert.equal(goalIsGreen(fakeGoalResult()), true);
    assert.equal(goalIsGreen(fakeGoalResult({ met: false })), false);
    assert.equal(
      goalIsGreen(
        fakeGoalResult({
          lastResult: { filesChanged: [], verification: null },
        }),
      ),
      false,
    );
    assert.equal(
      goalIsGreen(
        fakeGoalResult({
          lastResult: {
            filesChanged: ['x'],
            verification: { passed: false },
          },
        }),
      ),
      false,
    );
  });
});

describe('option resolvers', () => {
  const envKeys = [
    'KODR_LOOP_MAX_ATTEMPTS',
    'KODR_LOOP_GOAL_MAX_ATTEMPTS',
    'KODR_LOOP_RETRY_BACKOFF_MS',
    'KODR_LOOP_STOP_ON_PARK',
    'KODR_LOOP_MAX_MS',
    'KODR_LOOP_MAX_COST',
    'KODR_LOOP_MAX_TASKS',
    'KODR_LOOP_TASKS_FILE',
    'KODR_LOOP_RESET_PATHS',
  ];
  const saved = {};
  for (const key of envKeys) {
    saved[key] = process.env[key];
  }
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('resolves option, then env, then default', () => {
    delete process.env.KODR_LOOP_MAX_ATTEMPTS;
    assert.equal(loopMaxAttempts(undefined), 3);
    process.env.KODR_LOOP_MAX_ATTEMPTS = '7';
    assert.equal(loopMaxAttempts(undefined), 7);
    assert.equal(loopMaxAttempts(2), 2);
  });

  it('goalMaxAttempts defaults to one more than a plain task', () => {
    delete process.env.KODR_LOOP_GOAL_MAX_ATTEMPTS;
    assert.equal(loopGoalMaxAttempts(undefined), 4);
  });

  it('retryBackoffMs resolves option, then env, then default', () => {
    delete process.env.KODR_LOOP_RETRY_BACKOFF_MS;
    assert.equal(loopRetryBackoffMs(undefined), 5000);
    assert.equal(loopRetryBackoffMs(0), 0);
  });

  it('stopOnPark resolves option, then env, then default true', () => {
    delete process.env.KODR_LOOP_STOP_ON_PARK;
    assert.equal(loopStopOnPark(undefined), true);
    process.env.KODR_LOOP_STOP_ON_PARK = '0';
    assert.equal(loopStopOnPark(undefined), false);
    assert.equal(loopStopOnPark(true), true);
  });

  it('maxLoopMs/maxLoopCost/maxTasks default to 0 (disabled)', () => {
    delete process.env.KODR_LOOP_MAX_MS;
    delete process.env.KODR_LOOP_MAX_COST;
    delete process.env.KODR_LOOP_MAX_TASKS;
    assert.equal(loopMaxLoopMs(undefined), 0);
    assert.equal(loopMaxLoopCost(undefined), 0);
    assert.equal(loopMaxTasks(undefined), 0);
  });

  it('tasksFile resolves option, then env, then TASKS.md', () => {
    delete process.env.KODR_LOOP_TASKS_FILE;
    assert.equal(loopTasksFile(undefined), 'TASKS.md');
    process.env.KODR_LOOP_TASKS_FILE = 'PLAN.md';
    assert.equal(loopTasksFile(undefined), 'PLAN.md');
  });

  it('resetPaths resolves option, then env (space-separated), then empty', () => {
    delete process.env.KODR_LOOP_RESET_PATHS;
    assert.deepEqual(loopResetPaths(undefined), []);
    process.env.KODR_LOOP_RESET_PATHS = 'data cache';
    assert.deepEqual(loopResetPaths(undefined), ['data', 'cache']);
    assert.deepEqual(loopResetPaths(['explicit']), ['explicit']);
  });

  it('parseArgs leaves --max-attempts unset as null so KODR_LOOP_MAX_ATTEMPTS still reaches the resolver', () => {
    const args = parseArgs(['loop']);
    assert.equal(args.maxAttempts, null);
    delete process.env.KODR_LOOP_MAX_ATTEMPTS;
    assert.equal(loopMaxAttempts(args.maxAttempts), 3);
    process.env.KODR_LOOP_MAX_ATTEMPTS = '9';
    assert.equal(loopMaxAttempts(args.maxAttempts), 9);
  });
});

describe('readNextTask / markFirstTask', () => {
  it('reads and marks against a real temp file', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeFile, readFile } = await import('node:fs/promises');

    const dir = await mkdtemp(join(tmpdir(), 'kodr-loop-checklist-'));
    const file = join(dir, 'TASKS.md');
    await writeFile(file, '# Tasks\n\n- [ ] first\n- [ ] second\n');

    assert.equal(await readNextTask(file), 'first');
    await markFirstTask(file, 'x');
    assert.equal(await readNextTask(file), 'second');
    const content = await readFile(file, 'utf8');
    assert.match(content, /- \[x\] first/);
    await markFirstTask(file, '!');
    assert.equal(await readNextTask(file), null);

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the checklist is missing', async () => {
    assert.equal(await readNextTask('/nonexistent/TASKS.md'), null);
  });
});

describe('validateLoopStart', () => {
  it('refuses outside a git repo, with an explicit message', async () => {
    const result = await validateLoopStart({
      isRepo: async () => false,
      tasksFileExists: async () => true,
      hasCommits: async () => true,
      tasksFileTracked: async () => true,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /git repo/);
  });

  it('refuses when the checklist is missing', async () => {
    const result = await validateLoopStart({
      isRepo: async () => true,
      tasksFileExists: async () => false,
      hasCommits: async () => true,
      tasksFileTracked: async () => true,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /checklist/);
  });

  it('refuses in a repo with no commits', async () => {
    const result = await validateLoopStart({
      isRepo: async () => true,
      tasksFileExists: async () => true,
      hasCommits: async () => false,
      tasksFileTracked: async () => true,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /no commits/);
  });

  it('refuses an untracked checklist -- the first park would delete it', async () => {
    const result = await validateLoopStart({
      isRepo: async () => true,
      tasksFileExists: async () => true,
      hasCommits: async () => true,
      tasksFileTracked: async () => false,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /not tracked/);
  });

  it('passes when every precondition holds', async () => {
    const result = await validateLoopStart({
      isRepo: async () => true,
      tasksFileExists: async () => true,
      hasCommits: async () => true,
      tasksFileTracked: async () => true,
    });
    assert.equal(result.ok, true);
  });
});

describe('runLoop', () => {
  it('a green task commits once, checklist marked before the commit', async () => {
    const checklist = fakeChecklist(['add a test']);
    const git = fakeGit();
    const events = [];
    const origMark = checklist.markTask;
    checklist.markTask = async (mark) => {
      events.push(`mark:${mark}`);
      await origMark(mark);
    };
    const origCommit = git.commitGreen;
    git.commitGreen = async (message) => {
      events.push(`commit:${message}`);
      return origCommit(message);
    };

    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git,
      reporter: silentReporter,
    });

    assert.equal(result.reason, 'backlog-empty');
    assert.equal(result.green, 1);
    assert.equal(git.commitCalls.length, 1);
    assert.deepEqual(events, ['mark:x', 'commit:kodr: add a test']);
    assert.equal(checklist.items[0].mark, 'x');
  });

  it('a red task retries in place with the prior transcript replayed, up to maxAttempts', async () => {
    const checklist = fakeChecklist(['fix the bug']);
    const git = fakeGit();
    const continuations = [];
    let calls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async (text, continuation) => {
        calls += 1;
        continuations.push(continuation);
        return fakeRunResult({ stoppedReason: 'tool-limit' });
      },
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 3,
      reporter: silentReporter,
    });

    assert.equal(calls, 3);
    assert.equal(continuations[0], null);
    assert.ok(Array.isArray(continuations[1].priorMessages));
    assert.deepEqual(continuations[1].priorFilesChanged, ['a.mjs']);
    assert.equal(result.reason, 'parked');
    assert.equal(result.parked, 1);
  });

  it('a task that never goes green parks: reset/clean, mark "!", its own commit', async () => {
    const checklist = fakeChecklist(['fix the bug']);
    const git = fakeGit();
    await runLoop({
      checklist,
      buildTask: async () => fakeRunResult({ stoppedReason: 'tool-limit' }),
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 1,
      reporter: silentReporter,
    });

    assert.equal(git.parkCalls.length, 1);
    assert.equal(checklist.items[0].mark, '!');
    assert.equal(git.commitCalls.length, 1);
    assert.match(git.commitCalls[0], /^kodr: park /);
  });

  it('an empty backlog exits cleanly with reason "backlog-empty"', async () => {
    const result = await runLoop({
      checklist: fakeChecklist([]),
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      reporter: silentReporter,
    });
    assert.equal(result.reason, 'backlog-empty');
    assert.equal(result.green, 0);
    assert.equal(result.parked, 0);
  });

  it('a no-op completion is not green and does not commit', async () => {
    const checklist = fakeChecklist(['do nothing']);
    const git = fakeGit();
    await runLoop({
      checklist,
      buildTask: async () =>
        fakeRunResult({ noOpCompletion: true, filesChanged: [] }),
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 1,
      reporter: silentReporter,
    });
    assert.equal(checklist.items[0].mark, '!');
    assert.equal(git.parkCalls.length, 1);
  });

  it('a "GOAL: " line routes to buildGoal, not buildTask', async () => {
    const checklist = fakeChecklist(['GOAL: docs are complete']);
    let taskCalls = 0;
    let goalCalls = 0;
    let goalArg = null;
    await runLoop({
      checklist,
      buildTask: async () => {
        taskCalls += 1;
        return fakeRunResult();
      },
      buildGoal: async (text) => {
        goalCalls += 1;
        goalArg = text;
        return fakeGoalResult();
      },
      git: fakeGit(),
      reporter: silentReporter,
    });
    assert.equal(taskCalls, 0);
    assert.equal(goalCalls, 1);
    assert.equal(goalArg, 'docs are complete');
  });

  it('a plain line routes to buildTask, not buildGoal', async () => {
    const checklist = fakeChecklist(['add a test']);
    let taskCalls = 0;
    let goalCalls = 0;
    await runLoop({
      checklist,
      buildTask: async () => {
        taskCalls += 1;
        return fakeRunResult();
      },
      buildGoal: async () => {
        goalCalls += 1;
        return fakeGoalResult();
      },
      git: fakeGit(),
      reporter: silentReporter,
    });
    assert.equal(taskCalls, 1);
    assert.equal(goalCalls, 0);
  });

  it('a GOAL: item gets exactly one buildGoal invocation, then green or park', async () => {
    const checklist = fakeChecklist(['GOAL: something']);
    let goalCalls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => {
        goalCalls += 1;
        return fakeGoalResult({ met: false, lastResult: { filesChanged: [] } });
      },
      git: fakeGit(),
      maxAttempts: 5,
      reporter: silentReporter,
    });
    assert.equal(goalCalls, 1);
    assert.equal(result.parked, 1);
  });

  it("the park entry records the goal's attempts and reason", async () => {
    const checklist = fakeChecklist(['GOAL: something']);
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () =>
        fakeGoalResult({
          met: false,
          reason: 'exhausted',
          attempts: 4,
          lastResult: { filesChanged: [] },
        }),
      git: fakeGit(),
      stopOnPark: false,
      reporter: silentReporter,
    });
    assert.equal(result.tasks[0].attempts, 4);
    assert.equal(result.tasks[0].goalReason, 'exhausted');
  });

  it('an attempt ending stoppedReason "error" waits retryBackoffMs before the retry', async () => {
    const checklist = fakeChecklist(['flaky']);
    const clock = fakeClock();
    let calls = 0;
    await runLoop({
      checklist,
      buildTask: async () => {
        calls += 1;
        if (calls < 3) {
          return fakeRunResult({ stoppedReason: 'error' });
        }
        return fakeRunResult();
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxAttempts: 3,
      retryBackoffMs: 250,
      clock,
      reporter: silentReporter,
    });
    assert.deepEqual(clock.waits, [250, 250]);
  });

  it('no backoff before the final attempt -- a park already happening is not delayed', async () => {
    const checklist = fakeChecklist(['flaky']);
    const clock = fakeClock();
    await runLoop({
      checklist,
      buildTask: async () => fakeRunResult({ stoppedReason: 'error' }),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxAttempts: 2,
      retryBackoffMs: 250,
      clock,
      reporter: silentReporter,
    });
    assert.deepEqual(clock.waits, [250]);
  });

  it('no backoff on a genuine build failure', async () => {
    const checklist = fakeChecklist(['flaky']);
    const clock = fakeClock();
    await runLoop({
      checklist,
      buildTask: async () => fakeRunResult({ stoppedReason: 'tool-limit' }),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxAttempts: 2,
      retryBackoffMs: 250,
      clock,
      reporter: silentReporter,
    });
    assert.deepEqual(clock.waits, []);
  });

  it('resetPaths are passed through to git.park on a park', async () => {
    const checklist = fakeChecklist(['fix it']);
    const git = fakeGit();
    await runLoop({
      checklist,
      buildTask: async () => fakeRunResult({ stoppedReason: 'tool-limit' }),
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 1,
      resetPaths: ['data'],
      reporter: silentReporter,
    });
    assert.deepEqual(git.parkCalls, [['data']]);
  });

  it('a refused resetPaths entry is reported via the reporter, and the loop continues', async () => {
    const checklist = fakeChecklist(['fix it']);
    const notices = [];
    const reporter = {
      ...silentReporter,
      notice: (text) => notices.push(text),
    };
    const git = fakeGit({
      park: async () => ({ ok: true, wiped: [], refused: ['..'] }),
    });
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult({ stoppedReason: 'tool-limit' }),
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 1,
      reporter,
    });
    assert.equal(result.reason, 'parked');
    assert.ok(notices.some((n) => n.includes('..')));
  });

  it("a parked task's entry survives the park and lands in the record", async () => {
    const checklist = fakeChecklist(['fix it']);
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult({ stoppedReason: 'tool-limit' }),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxAttempts: 1,
      reporter: silentReporter,
    });
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].status, 'parked');
  });

  it('a park stops the loop by default, with the park committed first', async () => {
    const checklist = fakeChecklist(['fix it', 'later task']);
    const git = fakeGit();
    let taskCalls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async () => {
        taskCalls += 1;
        return fakeRunResult({ stoppedReason: 'tool-limit' });
      },
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 1,
      reporter: silentReporter,
    });
    assert.equal(result.reason, 'parked');
    assert.equal(taskCalls, 1);
    assert.equal(git.commitCalls.length, 1);
    assert.equal(checklist.items[1].mark, ' ');
  });

  it('stopOnPark false carries on to the next task after a park', async () => {
    const checklist = fakeChecklist(['fix it', 'later task']);
    let taskCalls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async (text) => {
        taskCalls += 1;
        if (text === 'fix it') {
          return fakeRunResult({ stoppedReason: 'tool-limit' });
        }
        return fakeRunResult();
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxAttempts: 1,
      stopOnPark: false,
      reporter: silentReporter,
    });
    assert.equal(taskCalls, 2);
    assert.equal(result.reason, 'backlog-empty');
    assert.equal(result.green, 1);
    assert.equal(result.parked, 1);
  });

  it('a failed commit after a green build stops the loop with reason "commit-failed"', async () => {
    const checklist = fakeChecklist(['add a test']);
    const git = fakeGit({
      commitGreen: async () => ({ ok: false, error: 'git commit failed: x' }),
    });
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git,
      reporter: silentReporter,
    });
    assert.equal(result.reason, 'commit-failed');
    assert.equal(result.tasks[0].error, 'git commit failed: x');
  });

  it('a failed park-mark commit stops the loop with reason "commit-failed"', async () => {
    const checklist = fakeChecklist(['fix it']);
    const git = fakeGit({
      commitGreen: async () => ({ ok: false, error: 'git commit failed: y' }),
    });
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult({ stoppedReason: 'tool-limit' }),
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 1,
      reporter: silentReporter,
    });
    assert.equal(result.reason, 'commit-failed');
  });

  it('a benign "no changes to commit" does not stop the loop', async () => {
    const checklist = fakeChecklist(['add a test']);
    const git = fakeGit({
      commitGreen: async () => ({ ok: false, reason: 'no changes to commit' }),
    });
    const notices = [];
    const reporter = { ...silentReporter, notice: (t) => notices.push(t) };
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git,
      reporter,
    });
    assert.equal(result.reason, 'backlog-empty');
    assert.equal(result.green, 1);
    assert.equal(result.tasks[0].commit, undefined);
    assert.ok(notices.some((n) => n.includes('no changes to commit')));
  });

  it('a cancelled plain task stops the loop without marking, committing, or parking', async () => {
    const checklist = fakeChecklist(['fix it']);
    const git = fakeGit();
    let taskCalls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async () => {
        taskCalls += 1;
        return fakeRunResult({ stoppedReason: 'cancelled' });
      },
      buildGoal: async () => fakeGoalResult(),
      git,
      maxAttempts: 3,
      reporter: silentReporter,
    });
    assert.equal(taskCalls, 1);
    assert.equal(result.reason, 'cancelled');
    assert.equal(git.commitCalls.length, 0);
    assert.equal(git.parkCalls.length, 0);
    assert.equal(checklist.items[0].mark, ' ');
    assert.equal(result.tasks[0].status, 'cancelled');
  });

  it('a cancelled GOAL: item stops the loop without marking, committing, or parking', async () => {
    const checklist = fakeChecklist(['GOAL: something']);
    const git = fakeGit();
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () =>
        fakeGoalResult({
          met: false,
          lastResult: { filesChanged: [], stoppedReason: 'cancelled' },
        }),
      git,
      reporter: silentReporter,
    });
    assert.equal(result.reason, 'cancelled');
    assert.equal(git.commitCalls.length, 0);
    assert.equal(git.parkCalls.length, 0);
    assert.equal(checklist.items[0].mark, ' ');
  });

  it('a GOAL: item cancelled between attempts stops the loop instead of parking', async () => {
    // The dangerous shape: runGoal reports reason "cancelled" while the last
    // build it managed to run looks perfectly healthy (stoppedReason
    // "complete") -- a cancel caught between attempts, or during a completed
    // attempt's post-build phase. Reading lastResult.stoppedReason alone
    // missed this and fell through to park(), which is reset --hard plus
    // clean -fd over the work the operator had just interrupted.
    const checklist = fakeChecklist(['GOAL: something']);
    const git = fakeGit();
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () =>
        fakeGoalResult({
          met: false,
          reason: 'cancelled',
          lastResult: { filesChanged: ['a.mjs'], stoppedReason: 'complete' },
        }),
      git,
      reporter: silentReporter,
    });
    assert.equal(result.reason, 'cancelled');
    assert.equal(git.parkCalls.length, 0, 'must not discard interrupted work');
    assert.equal(git.commitCalls.length, 0);
    assert.equal(checklist.items[0].mark, ' ');
  });

  it('the loop record is written after every task transition, not only at the end', async () => {
    const checklist = fakeChecklist(['one', 'two']);
    const snapshots = [];
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      onRecord: (record) => {
        snapshots.push(JSON.parse(JSON.stringify(record)));
      },
      reporter: silentReporter,
    });
    assert.equal(result.reason, 'backlog-empty');
    // One write per transition (2 tasks) plus the final backlog-empty write.
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[0].tasks.length, 1);
    assert.equal(snapshots[1].tasks.length, 2);
    assert.equal(snapshots[2].reason, 'backlog-empty');
  });

  it('the loop record names the commit and attempts for each task', async () => {
    const checklist = fakeChecklist(['add a test']);
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      reporter: silentReporter,
    });
    assert.equal(result.tasks[0].commit, 'sha-1');
    assert.equal(result.tasks[0].attempts, 1);
  });

  it("a task entry's usage sums every attempt, not just the last one", async () => {
    const checklist = fakeChecklist(['flaky']);
    let calls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async () => {
        calls += 1;
        if (calls === 1) {
          return fakeRunResult({
            stoppedReason: 'tool-limit',
            usage: { prompt: 10, completion: 5, cost: 1 },
          });
        }
        return fakeRunResult({
          usage: { prompt: 7, completion: 3, cost: 0.5 },
        });
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxAttempts: 2,
      reporter: silentReporter,
    });
    assert.deepEqual(result.tasks[0].usage, {
      prompt: 17,
      completion: 8,
      cost: 1.5,
    });
  });

  it('a loop killed mid-task leaves every completed transition on disk', async () => {
    const checklist = fakeChecklist(['one', 'two']);
    const snapshots = [];
    let calls = 0;
    await assert.rejects(
      runLoop({
        checklist,
        buildTask: async () => {
          calls += 1;
          if (calls === 2) {
            throw new Error('simulated crash');
          }
          return fakeRunResult();
        },
        buildGoal: async () => fakeGoalResult(),
        git: fakeGit(),
        onRecord: (record) => {
          snapshots.push(JSON.parse(JSON.stringify(record)));
        },
        reporter: silentReporter,
      }),
      /simulated crash/,
    );
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].tasks[0].status, 'green');
  });

  it('maxLoopMs stops between tasks with reason "budget", never mid-task', async () => {
    const checklist = fakeChecklist(['one', 'two']);
    const clock = fakeClock();
    let taskCalls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async () => {
        taskCalls += 1;
        clock.advance(1000);
        return fakeRunResult();
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxLoopMs: 500,
      clock,
      reporter: silentReporter,
    });
    assert.equal(taskCalls, 1);
    assert.equal(result.reason, 'budget');
    assert.equal(result.green, 1);
  });

  it('maxLoopCost stops between tasks once summed usage crosses the ceiling', async () => {
    const checklist = fakeChecklist(['one', 'two']);
    let taskCalls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async () => {
        taskCalls += 1;
        return fakeRunResult({ usage: { prompt: 1, completion: 1, cost: 1 } });
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxLoopCost: 1,
      reporter: silentReporter,
    });
    assert.equal(taskCalls, 1);
    assert.equal(result.reason, 'budget');
  });

  it('maxTasks stops after the configured number of tasks', async () => {
    const checklist = fakeChecklist(['one', 'two', 'three']);
    let taskCalls = 0;
    const result = await runLoop({
      checklist,
      buildTask: async () => {
        taskCalls += 1;
        return fakeRunResult();
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxTasks: 2,
      reporter: silentReporter,
    });
    assert.equal(taskCalls, 2);
    assert.equal(result.reason, 'budget');
  });

  it('a budget stop leaves a committed tree and an accurate checklist', async () => {
    const checklist = fakeChecklist(['one', 'two']);
    await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      maxTasks: 1,
      reporter: silentReporter,
    });
    assert.equal(checklist.items[0].mark, 'x');
    assert.equal(checklist.items[1].mark, ' ');
  });

  it('re-invoking after a budget stop resumes at the first unchecked item', async () => {
    const checklist = fakeChecklist(['one', 'two']);
    const git = fakeGit();
    await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git,
      maxTasks: 1,
      reporter: silentReporter,
    });
    const second = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git,
      reporter: silentReporter,
    });
    assert.equal(second.reason, 'backlog-empty');
    assert.equal(second.green, 1);
    assert.equal(checklist.items[1].mark, 'x');
  });

  it('usage and durationMs are summed across every run and judge call', async () => {
    const checklist = fakeChecklist(['GOAL: something']);
    const clock = fakeClock();
    const result = await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => {
        clock.advance(500);
        return fakeGoalResult({
          usage: { prompt: 20, completion: 10, cost: 2 },
        });
      },
      git: fakeGit(),
      clock,
      reporter: silentReporter,
    });
    assert.equal(result.usage.prompt, 20);
    assert.equal(result.usage.completion, 10);
    assert.equal(result.usage.cost, 2);
    assert.equal(result.durationMs, 500);
  });

  it('loop phases and notices reach the injected reporter', async () => {
    const checklist = fakeChecklist(['add a test']);
    const phases = [];
    const reporter = { ...silentReporter, phase: (name) => phases.push(name) };
    await runLoop({
      checklist,
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      reporter,
    });
    assert.ok(phases.some((p) => p.includes('add a test')));
  });
});

describe('parseArgs (loop subcommand)', () => {
  it('parses the loop subcommand with no prompt', () => {
    const args = parseArgs(['loop']);
    assert.equal(args.command, 'loop');
    assert.equal(args.prompt, null);
  });

  it('parses --tasks, --max-attempts, and the loop budgets', () => {
    const args = parseArgs([
      'loop',
      '--tasks',
      'PLAN.md',
      '--max-attempts',
      '5',
      '--goal-max-attempts',
      '6',
      '--retry-backoff-ms',
      '1000',
      '--reset-paths',
      'data',
      '--reset-paths',
      'cache',
      '--no-stop-on-park',
      '--max-loop-ms',
      '60000',
      '--max-loop-cost',
      '2.5',
      '--max-tasks',
      '10',
    ]);
    assert.equal(args.command, 'loop');
    assert.equal(args.tasksFile, 'PLAN.md');
    assert.equal(args.maxAttempts, 5);
    assert.equal(args.goalMaxAttempts, 6);
    assert.equal(args.retryBackoffMs, 1000);
    assert.deepEqual(args.resetPaths, ['data', 'cache']);
    assert.equal(args.stopOnPark, false);
    assert.equal(args.maxLoopMs, 60000);
    assert.equal(args.maxLoopCost, 2.5);
    assert.equal(args.maxTasks, 10);
  });

  it('--stop-on-park sets stopOnPark true explicitly', () => {
    const args = parseArgs(['loop', '--stop-on-park']);
    assert.equal(args.stopOnPark, true);
  });
});

describe('the review gate in the loop', () => {
  const blockedReview = {
    skipped: false,
    verdict: 'fail',
    grounded: true,
    passed: false,
    findings: 'greet.mjs contains literal \\n escapes.',
  };
  const passedReview = {
    skipped: false,
    verdict: 'pass',
    grounded: true,
    passed: true,
    findings: 'No findings.',
  };

  it('taskIsGreen ignores a failed review unless failOnReview is set', () => {
    const result = fakeRunResult({ review: blockedReview });
    assert.equal(taskIsGreen(result), true);
    assert.equal(taskIsGreen(result, { failOnReview: true }), false);
  });

  it('goalIsGreen ignores a failed review unless failOnReview is set', () => {
    const goalResult = fakeGoalResult({
      met: true,
      lastResult: fakeRunResult({ review: blockedReview }),
    });
    assert.equal(goalIsGreen(goalResult), true);
    assert.equal(goalIsGreen(goalResult, { failOnReview: true }), false);
  });

  it('a task whose review verdict is FAIL is not green and is not committed', async () => {
    const git = fakeGit();
    const result = await runLoop({
      checklist: fakeChecklist(['add greet.mjs']),
      buildTask: async () => fakeRunResult({ review: blockedReview }),
      buildGoal: async () => fakeGoalResult(),
      git,
      clock: fakeClock(),
      maxAttempts: 2,
      failOnReview: true,
      stopOnPark: true,
    });

    assert.equal(result.green, 0);
    assert.equal(result.parked, 1);
    assert.equal(git.commitCalls.length, 1); // the park's own mark commit
    assert.match(git.commitCalls[0], /^kodr: park /);
    assert.equal(git.parkCalls.length, 1);
  });

  it('a review FAIL is advisory by default -- the task still goes green and commits', async () => {
    const git = fakeGit();
    const result = await runLoop({
      checklist: fakeChecklist(['add greet.mjs']),
      buildTask: async () => fakeRunResult({ review: blockedReview }),
      buildGoal: async () => fakeGoalResult(),
      git,
      clock: fakeClock(),
      maxAttempts: 2,
    });

    assert.equal(result.green, 1);
    assert.equal(result.parked, 0);
    assert.equal(git.parkCalls.length, 0);
  });

  it("retries a review FAIL with the reviewer's findings in the prompt", async () => {
    const prompts = [];
    const notices = [];
    const reviews = [blockedReview, passedReview];
    let n = 0;
    const result = await runLoop({
      checklist: fakeChecklist(['add greet.mjs']),
      buildTask: async (prompt) => {
        prompts.push(prompt);
        return fakeRunResult({ review: reviews[n++] ?? passedReview });
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      clock: fakeClock(),
      reporter: { ...createNullReporter(), notice: (m) => notices.push(m) },
      maxAttempts: 3,
      failOnReview: true,
    });

    assert.equal(result.green, 1);
    assert.equal(prompts.length, 2);
    // First attempt gets the bare task; the retry gets the findings plus the
    // task restated.
    assert.equal(prompts[0], 'add greet.mjs');
    assert.match(prompts[1], /literal \\n escapes/);
    assert.match(prompts[1], /add greet\.mjs/);
    assert.match(prompts[1], /Do not start over/);
    assert.ok(notices.some((m) => /failed review/.test(m)));
  });

  it('parks a task whose review keeps failing, after maxAttempts', async () => {
    let calls = 0;
    const result = await runLoop({
      checklist: fakeChecklist(['add greet.mjs']),
      buildTask: async () => {
        calls += 1;
        return fakeRunResult({ review: blockedReview });
      },
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      clock: fakeClock(),
      maxAttempts: 3,
      failOnReview: true,
    });

    assert.equal(calls, 3);
    assert.equal(result.parked, 1);
  });

  it('never blocks a commit on a skipped review', async () => {
    const git = fakeGit();
    const result = await runLoop({
      checklist: fakeChecklist(['add greet.mjs']),
      buildTask: async () =>
        fakeRunResult({ review: { skipped: true, error: 'ECONNREFUSED' } }),
      buildGoal: async () => fakeGoalResult(),
      git,
      clock: fakeClock(),
      failOnReview: true,
    });

    assert.equal(result.green, 1);
    assert.equal(git.parkCalls.length, 0);
  });

  it('records the review verdict on the loop record entry', async () => {
    const result = await runLoop({
      checklist: fakeChecklist(['add greet.mjs']),
      buildTask: async () => fakeRunResult({ review: passedReview }),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      clock: fakeClock(),
    });

    assert.deepEqual(result.tasks[0].review, {
      verdict: 'pass',
      grounded: true,
      passed: true,
    });
  });

  it('leaves the loop record entry review null when no review ran', async () => {
    const result = await runLoop({
      checklist: fakeChecklist(['add greet.mjs']),
      buildTask: async () => fakeRunResult(),
      buildGoal: async () => fakeGoalResult(),
      git: fakeGit(),
      clock: fakeClock(),
    });
    assert.equal(result.tasks[0].review, null);
  });
});
