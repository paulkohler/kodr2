/**
 * `kodr loop` end to end (specs/loop.yaml) -- a small checklist mixing a
 * plain task and a `GOAL: ` item, driven against a real model. Everything
 * else about the loop is covered by test/loop.test.mjs and
 * test/loop-git.test.mjs with injected collaborators; what only a real run
 * can prove is that a real stoppedReason/verdict sequence still drives the
 * ratchet the loop-level unit tests assume, and that the loop record and
 * git history end up agreeing with each other.
 *
 * Run with: node --test eval/loop.eval.mjs
 * Requires LM Studio at localhost:1234. Defaults to qwen/qwen3-coder-30b;
 * override with KODR_TEST_MODEL.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const LM_STUDIO_URL = 'http://localhost:1234/v1';
const MODEL = process.env.KODR_TEST_MODEL || 'qwen/qwen3-coder-30b';
const KODR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'kodr.mjs',
);

// A cold JIT model load dominates a single call's wall clock, and this eval
// makes two (a plain task, then a GOAL: item's own build+judge) -- generous
// per-attempt budgets, capped attempts so a genuinely stuck model still ends
// the eval in bounded time rather than retrying for the full test timeout.
const BUDGET = [
  '--max-tool-turns',
  '8',
  '--max-run-ms',
  '240000',
  '--max-attempts',
  '2',
  '--goal-max-attempts',
  '2',
];

async function lmStudioAvailable() {
  return new Promise((resolve) => {
    const req = request(`${LM_STUDIO_URL}/models`, { timeout: 3000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function kodr(args, cwd) {
  const result = spawnSync('node', [KODR, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, KODR_MODEL: MODEL },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function commitSubjects(cwd) {
  return execFileSync('git', ['log', '--format=%s'], { cwd, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

const skip = (await lmStudioAvailable()) === false && 'LM Studio not available';

describe('kodr loop end to end', { skip }, () => {
  let ws;

  before(async () => {
    ws = await mkdtemp(join(tmpdir(), 'kodr-loop-eval-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
    execFileSync('git', ['config', 'user.email', 'loop-eval@test.invalid'], {
      cwd: ws,
    });
    execFileSync('git', ['config', 'user.name', 'Loop Eval'], { cwd: ws });
    await writeFile(
      join(ws, 'TASKS.md'),
      [
        '# Tasks',
        '',
        '- [ ] Create a file named hello.txt with the exact contents: hello',
        '- [ ] GOAL: a file named status.txt exists and contains the word done',
        '',
      ].join('\n'),
    );
    execFileSync('git', ['add', '-A'], { cwd: ws });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: ws });
  });

  after(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it('drives a plain task and a GOAL: item, each landing as its own commit', {
    timeout: 600000,
  }, async () => {
    const { stdout, stderr } = kodr(
      ['loop', '--json', '--no-fail', ...BUDGET],
      ws,
    );

    let result;
    assert.doesNotThrow(() => {
      result = JSON.parse(stdout);
    }, `kodr loop --json did not print parseable JSON on stdout:\n${stdout}\n${stderr}`);

    assert.equal(
      result.reason,
      'backlog-empty',
      `expected the checklist to finish (got "${result.reason}"): ${JSON.stringify(result.tasks)}`,
    );
    assert.equal(result.green, 2);
    assert.equal(result.parked, 0);

    const tasks = await readFile(join(ws, 'TASKS.md'), 'utf8');
    assert.doesNotMatch(tasks, /- \[ \] /, 'every item should be marked');
    assert.match(tasks, /- \[x\] Create a file named hello\.txt/);
    assert.match(tasks, /- \[x\] GOAL: a file named status\.txt/);

    const subjects = commitSubjects(ws);
    assert.ok(
      subjects.some((s) => s.startsWith('kodr: Create a file named hello.txt')),
    );
    assert.ok(
      subjects.some((s) => s.startsWith('kodr: GOAL: a file named status.txt')),
    );

    assert.ok(result.recordPath, 'runLoop should report a recordPath');
    assert.ok(
      existsSync(result.recordPath),
      'the loop record should exist on disk',
    );
    const record = JSON.parse(await readFile(result.recordPath, 'utf8'));
    assert.equal(record.reason, 'backlog-empty');
    assert.equal(record.green, 2);
    assert.equal(record.tasks.length, 2);
    const shas = execFileSync('git', ['log', '--format=%H'], {
      cwd: ws,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    assert.ok(record.tasks[0].commit && shas.includes(record.tasks[0].commit));
    assert.ok(record.tasks[1].commit && shas.includes(record.tasks[1].commit));

    // .kodr/ must never land in git history -- it's a run/loop transcript
    // directory, excluded at loop startup (see registerExcludes).
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: ws,
      encoding: 'utf8',
    });
    assert.doesNotMatch(tracked, /^\.kodr\//m);

    const loopRecords = await readdir(join(ws, '.kodr', 'loops'));
    assert.equal(loopRecords.length, 1);
  });
});
