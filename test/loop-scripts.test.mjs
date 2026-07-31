/**
 * Unit tests for the shipped driver scripts, examples/loop.sh and
 * examples/phased-loop.sh — the ratchet that drives Kodr over a checklist
 * unattended. See specs/loop-scripts.yaml.
 *
 * `kodr` and `sleep` are scripted stand-ins on PATH (test/fixtures/loop-bin);
 * everything else is real — a real temp git repo, real `git reset --hard`, real
 * `git clean -fd`. No model is faked because no model is involved in the
 * behaviour under test, the same stance runGoal's own loop tests take with
 * injected runTask/evaluate collaborators.
 *
 * The "regression" block is the point of the file: every case there is a bug
 * that actually happened, found by hand during a 15-phase CRM dogfooding run
 * (commit 2adb55d) at roughly five hours a pass. Four of the five failed
 * silently.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { afterEach, before, describe, it } from 'node:test';

import {
  LOOP_SH,
  PHASED_LOOP_SH,
  allCommittedFiles,
  bashTooOld,
  checkGoalContract,
  checkRunContract,
  commitSubjects,
  createLoopRepo,
  filesInHead,
  gitStatus,
  goalIsGreen,
  goalMet,
  goalUnmet,
  jqMissing,
  readRepoFile,
  repoFileExists,
  runGreen,
  runIsGreen,
  runLoop,
  runRed,
} from './loop-fixtures.mjs';

let skipReason = null;

before(() => {
  skipReason = bashTooOld() ?? jqMissing() ?? null;
});

let ctx = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

// node:test's `skip` is evaluated at definition time, so the guards are checked
// inside each case instead — a contributor on stock macOS bash 3.2 gets an
// explicit reason rather than an obscure unbound-variable failure.
function guard(t) {
  if (skipReason) {
    t.skip(skipReason);
    return true;
  }
  return false;
}

describe('loop.sh — the ratchet', () => {
  it('commits a green task once, with the checklist tick inside that commit', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['add a feature'] });

    const result = runLoop(ctx, { script: LOOP_SH, responses: [runGreen()] });

    assert.equal(result.status, 0);
    assert.deepEqual(commitSubjects(ctx.repo), ['kodr: add a feature', 'init']);

    // Mark-then-commit: the tick has to ride in the same commit as the code, or
    // a later task's `git reset --hard` silently reverts it and the task is redone.
    const head = filesInHead(ctx.repo);
    assert.ok(
      head.includes('TASKS.md'),
      `TASKS.md not in the green commit: ${head}`,
    );
    assert.ok(
      head.includes('src/feature.mjs'),
      `code not in the green commit: ${head}`,
    );
    assert.match(readRepoFile(ctx.repo, 'TASKS.md'), /- \[x\] add a feature/);
    assert.equal(gitStatus(ctx.repo), '');
  });

  it('retries in place with --continue last, then parks after MAX_ATTEMPTS', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['fix the thing'] });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 0);
    assert.equal(
      result.invocations.filter((argv) => argv[0] === 'run').length,
      3,
    );

    // First attempt fresh, every retry continuing in place.
    assert.ok(!result.invocations[0].includes('--continue'));
    assert.deepEqual(result.invocations[1].slice(-2), ['--continue', 'last']);
    assert.deepEqual(result.invocations[2].slice(-2), ['--continue', 'last']);

    assert.match(readRepoFile(ctx.repo, 'TASKS.md'), /- \[!\] fix the thing/);
    assert.deepEqual(commitSubjects(ctx.repo), [
      'kodr: park fix the thing',
      'init',
    ]);
    assert.equal(gitStatus(ctx.repo), '');
  });

  it('treats a no-op completion as not green and never commits it', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['do nothing'] });

    const noOp = {
      json: {
        completed: true,
        noOpCompletion: true,
        verified: true,
        stoppedReason: 'complete',
        filesChanged: [],
      },
    };
    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [noOp, noOp, noOp],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commitSubjects(ctx.repo), [
      'kodr: park do nothing',
      'init',
    ]);
  });

  it('treats a completed-but-unverified run as not green', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['break the tests'] });

    const failed = {
      write: { 'src/broken.mjs': 'syntax error\n' },
      json: {
        completed: true,
        noOpCompletion: false,
        verified: false,
        stoppedReason: 'complete',
        filesChanged: ['src/broken.mjs'],
      },
    };
    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [failed, failed, failed],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commitSubjects(ctx.repo), [
      'kodr: park break the tests',
      'init',
    ]);
    // The park reverted the broken file rather than leaving it on disk.
    assert.equal(repoFileExists(ctx.repo, 'src/broken.mjs'), false);
  });

  it('works through a multi-task checklist and stops on an empty backlog', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['first', 'second'] });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [
        runGreen({ 'src/first.mjs': 'export const a = 1;\n' }),
        runGreen({ 'src/second.mjs': 'export const b = 2;\n' }),
      ],
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /backlog empty\./);
    assert.deepEqual(commitSubjects(ctx.repo), [
      'kodr: second',
      'kodr: first',
      'init',
    ]);
    // The end-of-backlog summary still runs.
    assert.ok(result.invocations.some((argv) => argv[0] === 'stats'));
  });
});

describe('phased-loop.sh — the GOAL: branch', () => {
  it('routes a GOAL: line to kodr goal with GOAL_MAX_ATTEMPTS', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['GOAL: every endpoint has an owner check'],
    });

    const result = runLoop(ctx, {
      script: PHASED_LOOP_SH,
      responses: [goalMet()],
      env: { GOAL_MAX_ATTEMPTS: '4' },
    });

    assert.equal(result.status, 0);
    const [argv] = result.invocations;
    assert.equal(argv[0], 'goal');
    // The GOAL: prefix is stripped before the condition reaches kodr.
    assert.equal(argv[1], 'every endpoint has an owner check');
    const maxAttempts = argv.indexOf('--max-attempts');
    assert.ok(maxAttempts > 0);
    assert.equal(argv[maxAttempts + 1], '4');
    assert.deepEqual(commitSubjects(ctx.repo), [
      'kodr: GOAL: every endpoint has an owner check',
      'init',
    ]);
  });

  it('routes a plain line to kodr run with memory enabled', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['add input validation'] });

    const result = runLoop(ctx, {
      script: PHASED_LOOP_SH,
      responses: [runGreen()],
    });

    assert.equal(result.status, 0);
    const [argv] = result.invocations;
    assert.equal(argv[0], 'run');
    assert.ok(argv.includes('--memory'));
    assert.ok(argv.includes('--memory-auto-apply'));
  });

  it('gives a GOAL: item no outer retry loop — one invocation, then park', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['GOAL: the docs read clearly'] });

    const result = runLoop(ctx, {
      script: PHASED_LOOP_SH,
      responses: [goalUnmet({ reason: 'exhausted', attempts: 4 })],
      env: { MAX_ATTEMPTS: '3' },
    });

    // Exit 1: phased-loop.sh stops on a park by default (see STOP_ON_PARK).
    assert.equal(result.status, 1);
    // kodr goal already retried internally; re-running it fresh would repeat the
    // same attempts with no memory of what the judge said.
    assert.equal(
      result.invocations.filter((argv) => argv[0] === 'goal').length,
      1,
    );
    assert.match(result.stdout, /PARKED after 4 goal attempt\(s\): exhausted/);
    assert.match(
      readRepoFile(ctx.repo, 'TASKS.md'),
      /- \[!\] GOAL: the docs read clearly/,
    );
  });

  it('requires a met goal to have changed files and passed verification', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['GOAL: nothing actually changed'] });

    const result = runLoop(ctx, {
      script: PHASED_LOOP_SH,
      responses: [
        goalUnmet({ met: true, reason: 'met', attempts: 1, filesChanged: [] }),
      ],
    });

    // Exit 1: phased-loop.sh stops on a park by default (see STOP_ON_PARK).
    assert.equal(result.status, 1);
    // met, but nothing changed — not green, so it parks rather than committing.
    assert.deepEqual(commitSubjects(ctx.repo), [
      'kodr: park GOAL: nothing actually changed',
      'init',
    ]);
  });
});

describe('the --json consumption contract', () => {
  // eval/loop-contract.eval.mjs runs these same checks against the real binary.
  // Here they are pointed at deliberately drifted payloads, so the guard itself
  // is proven to bite without needing a model: a check that cannot fail is not
  // a guard, and the jq expressions alone cannot do this job — jq answers a
  // clean "false" for a renamed field, indistinguishable from a red run.

  it('accepts what the scripts are actually handed today', () => {
    assert.deepEqual(checkRunContract(runGreen().json), []);
    assert.deepEqual(checkGoalContract(goalMet().json), []);
  });

  it('accepts a null verified — no test command configured', () => {
    assert.deepEqual(
      checkRunContract({ ...runGreen().json, verified: null }),
      [],
    );
  });

  it('catches a renamed field the ratchet reads', () => {
    const { completed, ...renamed } = runGreen().json;
    renamed.complete = completed;
    assert.deepEqual(checkRunContract(renamed), ['missing field: completed']);
  });

  it('catches a retyped field', () => {
    const retyped = { ...runGreen().json, completed: 'yes', stoppedReason: 7 };
    assert.deepEqual(checkRunContract(retyped), [
      'completed should be boolean, got string',
      'stoppedReason should be string, got number',
    ]);
  });

  it('catches filesChanged ceasing to be an array', () => {
    const retyped = { ...goalMet().json, filesChanged: 3 };
    assert.deepEqual(checkGoalContract(retyped), [
      'filesChanged should be an array, got number',
    ]);
  });

  it('catches the park note losing reason or attempts', () => {
    const { reason, attempts, ...stripped } = goalMet().json;
    assert.deepEqual(checkGoalContract(stripped), [
      'missing field: reason',
      'missing field: attempts',
    ]);
  });

  it('agrees with the jq expressions the scripts run', () => {
    // The green decisions in JS must match what the shell computes, or the eval's
    // cross-check is comparing two different things.
    assert.equal(runIsGreen(runGreen().json), true);
    assert.equal(runIsGreen({ ...runGreen().json, verified: false }), false);
    assert.equal(
      runIsGreen({ ...runGreen().json, noOpCompletion: true }),
      false,
    );
    assert.equal(runIsGreen({ ...runGreen().json, verified: null }), true);
    assert.equal(goalIsGreen(goalMet().json), true);
    assert.equal(goalIsGreen({ ...goalMet().json, filesChanged: [] }), false);
    assert.equal(goalIsGreen({ ...goalMet().json, met: false }), false);
  });
});

// --- Regressions ----------------------------------------------------------
// Each case below is a bug that actually happened, found by hand across two
// five-hour runs of examples/phased-loop.sh against examples/crm/ and
// fixed in 2adb55d. Four of the five failed silently — the run looked healthy
// while it was already broken — which is exactly the class a live run catches
// only by luck and a test catches for free.

describe("regression: bug 1 — a park reverted the script's own log files", () => {
  it('keeps every park line when a later task parks after a green commit', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['parks first', 'goes green', 'parks last'],
    });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [
        runRed(),
        runRed(),
        runRed(),
        runGreen(),
        runRed(),
        runRed(),
        runRed(),
      ],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 0);
    // The live failure: loop.log was swept into the green commit, so the last
    // task's `git reset --hard` reverted it to that snapshot and threw away the
    // park line written moments earlier. A 15-phase run left the log frozen
    // after the first success, making a healthy run look dead within minutes.
    const log = readRepoFile(ctx.repo, 'loop.log');
    const parkLines = log.split('\n').filter((line) => line.includes('PARKED'));
    assert.equal(
      parkLines.length,
      2,
      `expected both park lines, got: ${JSON.stringify(log)}`,
    );
  });

  it('never commits its own log files', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['parks', 'goes green'] });

    runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed(), runGreen()],
      env: { MAX_ATTEMPTS: '3' },
    });

    const committed = allCommittedFiles(ctx.repo);
    assert.ok(
      !committed.includes('loop.log'),
      `loop.log was committed: ${committed}`,
    );
    assert.ok(
      !committed.includes('loop.out'),
      `loop.out was committed: ${committed}`,
    );
  });
});

describe('regression: bug 2 — no backoff on a transient backend error', () => {
  it('backs off before retrying an attempt that ended stoppedReason error', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['hits a flaky backend'] });

    const errored = runRed({ stoppedReason: 'error' });
    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [errored, errored, errored],
      env: { MAX_ATTEMPTS: '3', RETRY_BACKOFF_S: '7' },
    });

    assert.equal(result.status, 0);
    // Live: one phase burned all three attempts on back-to-back HTTP 500s
    // inside 200ms, so the model never got a real turn.
    assert.deepEqual(result.sleeps, ['7', '7']);
  });

  it('does not back off before the final attempt — a park already happening is not delayed', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['fails once then parks'] });

    const errored = runRed({ stoppedReason: 'error' });
    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [errored, errored],
      env: { MAX_ATTEMPTS: '2', RETRY_BACKOFF_S: '7' },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(result.sleeps, ['7']);
  });

  it('does not back off on a genuine build failure — the model has to act, not wait', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['fails its tests'] });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3', RETRY_BACKOFF_S: '7' },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(result.sleeps, []);
  });
});

describe('regression: bug 3 — gitignored state survived a park', () => {
  it('wipes a RESET_PATHS directory the parked attempt mutated', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['migrates the database then fails'],
      gitignore: 'data/\n',
      untracked: { 'data/crm.db': 'schema drift from an abandoned attempt\n' },
    });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3', RESET_PATHS: 'data' },
    });

    assert.equal(result.status, 0);
    // Live: three parked phases left owner_id columns and a whole users table
    // permanently baked into data/crm.db, with zero trace in git history.
    assert.equal(repoFileExists(ctx.repo, 'data/crm.db'), false);
  });

  it('recreates a wiped RESET_PATHS directory empty rather than leaving it missing', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['fails'],
      gitignore: 'data/\n',
      untracked: { 'data/crm.db': 'state\n' },
    });

    runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3', RESET_PATHS: 'data' },
    });

    // A storage layer that opens data/crm.db typically assumes the directory
    // exists and never mkdir's it, so leaving it missing turned "wipe the
    // database" into "break every later phase until someone recreates it".
    assert.equal(repoFileExists(ctx.repo, 'data'), true);
    assert.deepEqual(readdirSync(`${ctx.repo}/data`), []);
  });

  it('refuses the egregious RESET_PATHS footguns and carries on', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['fails'] });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3', RESET_PATHS: '. .. .git /etc ../evil' },
    });

    assert.equal(result.status, 0);
    for (const refused of ['.', '..', '.git', '/etc', '../evil']) {
      assert.match(
        result.stderr,
        new RegExp(`refusing to rm -rf '${refused.replace('.', '\\.')}'`),
      );
    }
    assert.equal(repoFileExists(ctx.repo, 'README.md'), true);
    assert.equal(repoFileExists(ctx.repo, '.git'), true);
  });

  it('does not glob-expand an unquoted * in RESET_PATHS', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['fails'],
      gitignore: 'data/\n',
      untracked: { 'data/keep.db': 'state\n' },
    });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3', RESET_PATHS: '*' },
    });

    assert.equal(result.status, 0);
    // Without `set -f` this expands to every file in cwd and rm -rf's the tree.
    assert.equal(repoFileExists(ctx.repo, 'README.md'), true);
    assert.equal(repoFileExists(ctx.repo, 'TASKS.md'), true);
    assert.equal(repoFileExists(ctx.repo, 'data/keep.db'), true);
  });
});

describe('regression: bug 4 — an ignored-path advisory silently skipped every commit', () => {
  it("still commits when the log files are ALSO in the project's tracked .gitignore", async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['add a feature'],
      gitignore: 'loop.out\nloop.log\n',
    });

    const result = runLoop(ctx, { script: LOOP_SH, responses: [runGreen()] });

    assert.equal(result.status, 0);
    // The live failure: `git add -A -- . ':!loop.log'` exited non-zero on git's
    // "ignored paths" advisory, which silently skipped the `&& git commit`.
    // Five phases built correctly and were never committed, because mark_first
    // had already advanced the checklist in the working tree regardless.
    assert.deepEqual(commitSubjects(ctx.repo), ['kodr: add a feature', 'init']);
    assert.match(result.stdout, /committed\./);
  });

  it('self-registers its log files in .git/info/exclude at startup', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['add a feature'] });

    runLoop(ctx, { script: LOOP_SH, responses: [runGreen()] });

    const exclude = readRepoFile(ctx.repo, '.git/info/exclude');
    assert.match(exclude, /^loop\.out$/m);
    assert.match(exclude, /^loop\.log$/m);
  });

  it('stops non-zero when the commit after a green build fails', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['add a feature'],
      failCommitMatching: '^kodr: ',
    });

    const result = runLoop(ctx, { script: LOOP_SH, responses: [runGreen()] });

    // Fail loud: continuing here would build every later task on a false
    // assumption about what is committed.
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR: git commit failed after a green build/);
  });

  it('stops non-zero when the park-mark commit fails', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['never goes green'],
      failCommitMatching: '^kodr: park',
    });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR: failed to commit the park mark/);
  });
});

describe('regression: bug 5 — untracked debris contaminated the next task', () => {
  it('removes untracked debris left by a failed attempt', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['half-writes a test then fails'] });

    const debris = runRed({
      write: {
        'test/stray.test.mjs': "import { routes } from '../src/gone.mjs';\n",
      },
    });
    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [debris, debris, debris],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 0);
    // `node --test` auto-discovers every test file regardless of tracking, so
    // debris here silently failed the *next* phase's verification for a reason
    // that had nothing to do with it.
    assert.equal(repoFileExists(ctx.repo, 'test/stray.test.mjs'), false);
    assert.equal(gitStatus(ctx.repo), '');
  });

  it("leaves gitignored state alone when RESET_PATHS is unset — that is not git clean's job", async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({
      tasks: ['fails'],
      gitignore: 'data/\n',
      untracked: { 'data/keep.db': 'still here\n' },
    });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 0);
    // git clean without -x respects .gitignore; wiping ignored state is
    // RESET_PATHS's opt-in job alone.
    assert.equal(readRepoFile(ctx.repo, 'data/keep.db'), 'still here\n');
  });
});

describe("regression: bug 6 — a park destroyed the failed attempt's transcript", () => {
  // Found live driving a 4-task checklist with gemma-4-26b on LM Studio
  // (/Users/paul/src/loop-test-1). The scripts protect their own log files from
  // the park path but never protected .kodr/, where Kodr writes a run
  // transcript per attempt. Two halves, one cause: on green the transcripts
  // were swept into the project's history as commit noise, and on park they
  // were still untracked when `git clean -fd` ran, so they were deleted. The
  // attempts that FAILED are the ones worth a post-mortem, and they were the
  // only ones being destroyed.

  const RUN_RECORD = '.kodr/runs/2026-07-31T00-00-00-000Z.json';

  it('registers .kodr/ in .git/info/exclude at startup, in both scripts', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['add a feature'] });

    runLoop(ctx, { script: LOOP_SH, responses: [runGreen()] });
    assert.match(readRepoFile(ctx.repo, '.git/info/exclude'), /^\.kodr\/$/m);

    ctx = await createLoopRepo({ tasks: ['add a feature'] });
    runLoop(ctx, { script: PHASED_LOOP_SH, responses: [runGreen()] });
    assert.match(readRepoFile(ctx.repo, '.git/info/exclude'), /^\.kodr\/$/m);
  });

  it("keeps a parked attempt's run record — git clean must not take it", async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['never goes green'] });

    const withRecord = runRed({
      write: { [RUN_RECORD]: '{"stoppedReason":"tool-limit"}\n' },
    });
    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [withRecord, withRecord, withRecord],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 0);
    // The whole point of a park is that the attempt is abandoned — which makes
    // its transcript the only surviving evidence of why.
    assert.equal(
      repoFileExists(ctx.repo, RUN_RECORD),
      true,
      "the parked attempt's run record was deleted by the park path",
    );
  });

  it('never commits a run record into the project history', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['add a feature'] });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [
        runGreen({
          'src/feature.mjs': 'export const feature = true;\n',
          [RUN_RECORD]: '{"stoppedReason":"complete"}\n',
        }),
      ],
    });

    assert.equal(result.status, 0);
    const committed = allCommittedFiles(ctx.repo);
    assert.ok(
      committed.includes('src/feature.mjs'),
      `the code should still be committed: ${committed}`,
    );
    assert.ok(
      !committed.some((file) => file.startsWith('.kodr/')),
      `a run transcript was committed: ${committed}`,
    );
  });
});

describe('regression: bug 7 — a park in an uncommitted repo ate the checklist', () => {
  // examples/crm/'s own "Run it" block said: git init, copy the
  // checklist, launch. Nothing commits it, so nothing is tracked -- and
  // `git reset --hard` is a silent no-op with no HEAD, dropping the park
  // straight into `git clean -fd`, which deletes every untracked file in the
  // tree. Reproduced against the real script: the first park removed TASKS.md
  // itself, then mark_first's awk failed, then `git add TASKS.md` failed, and
  // the run died on phase 0 with the plan gone.

  for (const [name, script] of [
    ['loop.sh', LOOP_SH],
    ['phased-loop.sh', PHASED_LOOP_SH],
  ]) {
    it(`${name} refuses to start in a repo with no commits`, async (t) => {
      if (guard(t)) {
        return;
      }
      ctx = await createLoopRepo({
        tasks: ['scaffold the project'],
        noInitialCommit: true,
      });

      const result = runLoop(ctx, { script, responses: [runRed()] });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /no commits in this repo yet/);
      // Refused before spending a single model call.
      assert.equal(result.invocations.length, 0);
      // And above all, the checklist is still there.
      assert.equal(repoFileExists(ctx.repo, 'TASKS.md'), true);
    });
  }
});

describe('STOP_ON_PARK — a park stops an ordered checklist', () => {
  // A checklist is ordered, and a later item usually builds on an earlier one,
  // so carrying on past a park builds everything remaining against a
  // foundation that was just reverted. Caught live: a CRM plan parked its
  // Notes/Tasks phase and the next phase — a judged one, costing a build plus
  // a judge pass per attempt — went on to retrofit ownership scoping across
  // "companies, contacts, deals, notes, tasks" with the last two nonexistent.
  //
  // phased-loop.sh defaults to stopping (a phase plan is ordered by
  // definition); loop.sh defaults to carrying on (a backlog is often
  // independent tasks). Both honour the variable either way.

  it('phased-loop.sh stops after a park by default, leaving later tasks untouched', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['parks', 'never reached'] });

    const result = runLoop(ctx, {
      script: PHASED_LOOP_SH,
      responses: [runRed(), runRed(), runRed()],
      env: { MAX_ATTEMPTS: '3' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /stopping after a park/);
    // The park is committed before stopping, so a relaunch resumes cleanly.
    assert.deepEqual(commitSubjects(ctx.repo), ['kodr: park parks', 'init']);
    const tasks = readRepoFile(ctx.repo, 'TASKS.md');
    assert.match(tasks, /- \[!\] parks/);
    assert.match(tasks, /- \[ \] never reached/);
    // It never started the second task.
    assert.equal(result.invocations.filter((a) => a[0] === 'run').length, 3);
  });

  it('loop.sh carries on after a park by default', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['parks', 'still runs'] });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed(), runGreen()],
      env: { MAX_ATTEMPTS: '1' },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /backlog empty\./);
    assert.match(readRepoFile(ctx.repo, 'TASKS.md'), /- \[x\] still runs/);
  });

  it('STOP_ON_PARK=1 makes loop.sh stop too', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['parks', 'never reached'] });

    const result = runLoop(ctx, {
      script: LOOP_SH,
      responses: [runRed()],
      env: { MAX_ATTEMPTS: '1', STOP_ON_PARK: '1' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /stopping after a park/);
    assert.match(readRepoFile(ctx.repo, 'TASKS.md'), /- \[ \] never reached/);
  });

  it('STOP_ON_PARK=0 makes phased-loop.sh carry on', async (t) => {
    if (guard(t)) {
      return;
    }
    ctx = await createLoopRepo({ tasks: ['parks', 'still runs'] });

    const result = runLoop(ctx, {
      script: PHASED_LOOP_SH,
      responses: [runRed(), runGreen()],
      env: { MAX_ATTEMPTS: '1', STOP_ON_PARK: '0' },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /backlog empty\./);
    assert.match(readRepoFile(ctx.repo, 'TASKS.md'), /- \[x\] still runs/);
  });
});

describe('regression: bug 8 — a wrapped checklist item was silently truncated', () => {
  // next_task is a `grep -m1`, which returns the matching line and nothing
  // else. Every item in examples/crm/ was wrapped for readability, so
  // a live 15-phase run sent phase 0 to the model as the 11 words that fit on
  // the first line -- "Scaffold a zero-dependency Node CRM API: package.json
  // with no" -- and kept going, building against truncated prompts with
  // nothing in the log to say so. Reflowing markdown list items in shell is
  // the hazardous fix; one line per task is the contract instead, enforced
  // here so the truncation can never be silent again.

  for (const [name, script] of [
    ['loop.sh', LOOP_SH],
    ['phased-loop.sh', PHASED_LOOP_SH],
  ]) {
    it(`${name} refuses a checklist whose item wraps, naming the line`, async (t) => {
      if (guard(t)) {
        return;
      }
      ctx = await createLoopRepo({
        tasks: [
          'add a feature',
          'Scaffold a zero-dependency Node CRM API: package.json with no\n      dependencies and an npm test script',
        ],
      });

      const result = runLoop(ctx, { script, responses: [runGreen()] });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /wrap onto a continuation line/);
      // The line number points at the item's *first* line, which is what you
      // have to go and rejoin.
      assert.match(result.stderr, /line 4/);
      // Refused before spending a model call on the truncated prompt.
      assert.equal(result.invocations.length, 0);
    });
  }

  it('accepts a checklist whose items are each one line, however long', async (t) => {
    if (guard(t)) {
      return;
    }
    const long = `Scaffold a zero-dependency Node CRM API: ${'a long single-line task '.repeat(20)}`;
    ctx = await createLoopRepo({ tasks: [long] });

    const result = runLoop(ctx, { script: LOOP_SH, responses: [runGreen()] });

    assert.equal(result.status, 0);
    // The whole task reaches the model, not just what fit on a first line.
    assert.equal(result.invocations[0][1], long);
  });
});
