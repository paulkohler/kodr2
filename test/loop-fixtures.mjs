/**
 * Fixtures for the loop-script tests: a disposable git repo, a scripted `kodr`
 * and a recording `sleep` on PATH, and the spawn wrapper that drives
 * examples/loop.sh or examples/phased-loop.sh against them.
 *
 * Not a *.test.mjs file, so `node --test test/*.test.mjs` treats it as a plain
 * helper module rather than a test file.
 *
 * Every case runs in its own temp repo. Several of them assert on
 * `git reset --hard`, `git clean -fd` and `rm -rf`, so none of this may ever be
 * pointed at a real working tree — the repo and the stub's own state live in
 * separate directories under one temp root, and the stub state deliberately
 * sits *outside* the repo so it is never swept into a `git add -A`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const STUB_BIN = join(here, 'fixtures', 'loop-bin');

// Overridable so the suite can be pointed at an older revision of the scripts —
// the only way to prove the regression cases below actually have teeth is to run
// them against the code that had the bug:
//   git show 2f8f139:examples/loop.sh > /tmp/old/loop.sh
//   KODR_LOOP_SCRIPT_DIR=/tmp/old node --test test/loop-scripts.test.mjs
const scriptDir =
  process.env.KODR_LOOP_SCRIPT_DIR ?? join(here, '..', 'examples');
export const LOOP_SH = join(scriptDir, 'loop.sh');
export const PHASED_LOOP_SH = join(scriptDir, 'phased-loop.sh');

// Isolate git from the developer's own config: no global/system config (so a
// stray commit.gpgsign or template can't reach in), identity supplied by env so
// commits work without writing any config at all.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Loop Test',
  GIT_AUTHOR_EMAIL: 'loop@test.invalid',
  GIT_COMMITTER_NAME: 'Loop Test',
  GIT_COMMITTER_EMAIL: 'loop@test.invalid',
};

/**
 * The scripts need bash >= 4.4 — an empty array expansion like "${cont[@]}"
 * under `set -u` is an unbound-variable error on macOS's preinstalled 3.2.
 * Resolved the same way the scripts' own `#!/usr/bin/env bash` shebang does.
 */
export function bashTooOld() {
  // $BASH_VERSION rather than ${BASH_VERSINFO[@]}: same answer, and it keeps a
  // literal `${` out of a JS string, which reads as a mistaken template literal.
  const probe = spawnSync('bash', ['-c', 'echo $BASH_VERSION'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    return 'bash not found on PATH';
  }
  const version = probe.stdout.trim();
  const parsed = version.match(/^(\d+)\.(\d+)/);
  if (!parsed) {
    return `could not read a bash version from "${version}"`;
  }
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  if (major > 4) {
    return null;
  }
  if (major === 4 && minor >= 4) {
    return null;
  }
  return `bash ${version} is too old (the scripts need >= 4.4)`;
}

/** The scripts hard-require jq (`command -v jq` guard) to read kodr's --json. */
export function jqMissing() {
  const probe = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) {
    return null;
  }
  return 'jq not on PATH (the loop scripts require it)';
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
}

/**
 * A temp git repo with a seeded checklist and one initial commit.
 *
 * @param {object} options
 * @param {string[]} options.tasks Checklist lines, written as "- [ ] <task>"
 * @param {Record<string,string>} [options.files] Extra tracked files
 * @param {string} [options.gitignore] Contents of a tracked .gitignore
 * @param {Record<string,string>} [options.untracked] Files left untracked/ignored
 * @param {string} [options.failCommitMatching] A commit-msg hook rejects messages
 *   matching this grep pattern, to exercise the fail-loud commit paths
 */
export async function createLoopRepo(options) {
  const root = await mkdtemp(join(tmpdir(), 'kodr-loop-'));
  const repo = join(root, 'repo');
  const stub = join(root, 'stub');
  mkdirSync(repo);
  mkdirSync(stub);

  git(repo, ['init', '-q', '-b', 'main']);

  // Identity written into the repo's own config, not just supplied via GIT_ENV
  // below. GIT_ENV only reaches this helper and the bash scripts we spawn --
  // loop-git.mjs's commitAll runs in-process through the harness's curated
  // env (src/env.mjs allowlists HOME but nothing git-specific), so it reads
  // whatever ~/.gitconfig the machine happens to have. That passes on any
  // developer box and fails on a clean CI runner with "Author identity
  // unknown", which is exactly how it was found. gpgsign for the same reason:
  // a developer with commit.gpgsign=true globally would otherwise have
  // in-process commits fail here for a third reason.
  git(repo, ['config', 'user.name', 'Loop Test']);
  git(repo, ['config', 'user.email', 'loop@test.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);

  const tasks = options.tasks.map((task) => `- [ ] ${task}`).join('\n');
  writeFileSync(join(repo, 'TASKS.md'), `# Tasks\n\n${tasks}\n`);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');

  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }

  if (options.gitignore) {
    writeFileSync(join(repo, '.gitignore'), options.gitignore);
  }

  // noInitialCommit leaves a bare `git init` with nothing tracked — what an
  // operator has after following a "git init, copy the checklist, launch" style
  // of instruction. Nothing is tracked, so a park's `git clean -fd` would take
  // the checklist itself.
  if (!options.noInitialCommit) {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
  }

  // After the initial commit, so these stay untracked (or ignored) exactly as a
  // real run would leave them.
  for (const [path, content] of Object.entries(options.untracked ?? {})) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }

  if (options.failCommitMatching) {
    const hook = join(repo, '.git', 'hooks', 'commit-msg');
    writeFileSync(
      hook,
      `#!/bin/sh\ngrep -q '${options.failCommitMatching}' "$1" && exit 1\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
  }

  return {
    root,
    repo,
    stub,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Run one of the loop scripts against a scripted `kodr`.
 *
 * @param {{repo: string, stub: string}} ctx From createLoopRepo
 * @param {object} options
 * @param {string} options.script LOOP_SH or PHASED_LOOP_SH
 * @param {object[]} options.responses One entry consumed per run/goal invocation
 * @param {Record<string,string>} [options.env] Extra env (MAX_ATTEMPTS, RESET_PATHS, ...)
 */
export function runLoop(ctx, options) {
  const responsesPath = join(ctx.stub, 'responses.json');
  const statePath = join(ctx.stub, 'state');
  const argvPath = join(ctx.stub, 'argv.jsonl');
  const sleepPath = join(ctx.stub, 'sleep.log');

  writeFileSync(responsesPath, JSON.stringify(options.responses));
  writeFileSync(statePath, '0');
  writeFileSync(argvPath, '');
  writeFileSync(sleepPath, '');

  const result = spawnSync('bash', [options.script], {
    cwd: ctx.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${STUB_BIN}:${process.env.PATH}`,
      KODR_STUB_RESPONSES: responsesPath,
      KODR_STUB_STATE: statePath,
      KODR_STUB_ARGV: argvPath,
      KODR_STUB_SLEEP: sleepPath,
      // Keep argv assertions readable unless a case overrides them.
      TEST_CMD: '',
      RETRY_BACKOFF_S: '7',
      ...options.env,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    /** One argv array per kodr invocation, in order. */
    invocations: readLines(argvPath).map((line) => JSON.parse(line)),
    /** One entry per `sleep` call, its arguments joined. */
    sleeps: readLines(sleepPath),
  };
}

function readLines(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Commit subjects, newest first. */
export function commitSubjects(repo) {
  return git(repo, ['log', '--format=%s']).trim().split('\n').filter(Boolean);
}

/** Paths touched by HEAD. */
export function filesInHead(repo) {
  return git(repo, ['show', '--name-only', '--format=', 'HEAD'])
    .trim()
    .split('\n')
    .filter(Boolean);
}

/** Every path touched by any commit in the repo's history. */
export function allCommittedFiles(repo) {
  return git(repo, ['log', '--name-only', '--format='])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Working tree state — empty string means clean. */
export function gitStatus(repo) {
  return git(repo, ['status', '--porcelain']).trim();
}

export function readRepoFile(repo, path) {
  return readFileSync(join(repo, path), 'utf8');
}

export function repoFileExists(repo, path) {
  return existsSync(join(repo, path));
}

// --- The consumption contract ---------------------------------------------
// What the scripts actually read out of `kodr --json`. Shared with
// eval/loop-contract.eval.mjs, which runs these against the real binary.
//
// These checks carry the weight, and the jq expressions alone cannot: jq
// collapses a *missing* field to false, so `.completed and ...` still yields a
// clean "false" when every field has been renamed. In production that reads as
// "no run is ever green" and parks the entire backlog silently — the exact
// class of failure this whole suite exists for — so drift has to be caught by
// asserting the fields are there, not by asserting the expression still runs.

function checkField(problems, parsed, field, expected) {
  if (!(field in parsed)) {
    problems.push(`missing field: ${field}`);
    return;
  }
  if (expected === 'array') {
    if (!Array.isArray(parsed[field])) {
      problems.push(`${field} should be an array, got ${typeof parsed[field]}`);
    }
    return;
  }
  if (expected === 'present') {
    return;
  }
  if (typeof parsed[field] !== expected) {
    problems.push(
      `${field} should be ${expected}, got ${typeof parsed[field]}`,
    );
  }
}

/**
 * Fields loop.sh and phased-loop.sh read from `kodr run --json`.
 * @returns {string[]} Empty when the contract holds.
 */
export function checkRunContract(parsed) {
  const problems = [];
  checkField(problems, parsed, 'completed', 'boolean');
  checkField(problems, parsed, 'noOpCompletion', 'boolean');
  // `.verified != false` — true, false and null are all meaningful (null when
  // no test command was configured), so only presence can be asserted.
  checkField(problems, parsed, 'verified', 'present');
  checkField(problems, parsed, 'stoppedReason', 'string');
  return problems;
}

/**
 * Fields phased-loop.sh reads from `kodr goal --json`.
 * @returns {string[]} Empty when the contract holds.
 */
export function checkGoalContract(parsed) {
  const problems = [];
  checkField(problems, parsed, 'met', 'boolean');
  checkField(problems, parsed, 'filesChanged', 'array');
  checkField(problems, parsed, 'verified', 'present');
  checkField(problems, parsed, 'reason', 'string');
  checkField(problems, parsed, 'attempts', 'number');
  return problems;
}

/** The ratchet's green decision, in JS — examples/loop.sh:137. */
export function runIsGreen(parsed) {
  return (
    Boolean(parsed.completed) &&
    !parsed.noOpCompletion &&
    parsed.verified !== false
  );
}

/** The GOAL: branch's green decision, in JS — examples/phased-loop.sh:157. */
export function goalIsGreen(parsed) {
  return (
    Boolean(parsed.met) &&
    parsed.filesChanged.length > 0 &&
    parsed.verified !== false
  );
}

// --- Scripted response builders -------------------------------------------
// Built from the same field set the checks above pin.

/** A `kodr run` result the ratchet reads as green. */
export function runGreen(
  files = { 'src/feature.mjs': 'export const feature = true;\n' },
) {
  return {
    write: files,
    json: {
      completed: true,
      noOpCompletion: false,
      verified: true,
      stoppedReason: 'complete',
      filesChanged: Object.keys(files),
    },
  };
}

/** A `kodr run` result the ratchet reads as not green. */
export function runRed(over = {}) {
  const { write, ...json } = over;
  return {
    write: write ?? {},
    json: {
      completed: false,
      noOpCompletion: false,
      verified: false,
      stoppedReason: 'tool-limit',
      filesChanged: [],
      ...json,
    },
  };
}

/** A `kodr goal` result phased-loop reads as green. */
export function goalMet(
  files = { 'src/audited.mjs': 'export const audited = true;\n' },
) {
  return {
    write: files,
    json: {
      met: true,
      verified: true,
      reason: 'met',
      attempts: 1,
      filesChanged: Object.keys(files),
    },
  };
}

/** A `kodr goal` result phased-loop reads as not green. */
export function goalUnmet(over = {}) {
  return {
    write: {},
    json: {
      met: false,
      verified: true,
      reason: 'exhausted',
      attempts: 4,
      filesChanged: [],
      ...over,
    },
  };
}
