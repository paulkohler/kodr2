/**
 * Contract eval — the `kodr --json` fields examples/loop.sh and
 * examples/phased-loop.sh actually read, checked against the real binary.
 * See specs/loop-scripts.yaml.
 *
 * test/loop-scripts.test.mjs drives those scripts against a scripted `kodr` on
 * PATH, which is the only way to exercise the ratchet deterministically. The
 * risk that buys is drift: the stub is free to keep emitting a shape the real
 * CLI stopped producing, and every unit test would keep passing while a live
 * overnight run silently parked everything. This is the guard on that seam.
 *
 * Drift is caught by asserting the fields are present and correctly typed
 * (checkRunContract / checkGoalContract, shared with the unit suite), NOT by
 * checking the jq expressions still evaluate: jq collapses a missing field to a
 * clean "false", so `.completed and ...` answers false just as readily for a
 * renamed field as for a genuinely red run. The expressions are still run here,
 * cross-checked against the same decision computed in JS — agreement is what
 * proves they are reading live fields rather than a row of nulls.
 *
 * Run with: node --test eval/loop-contract.eval.mjs
 * Requires LM Studio at localhost:1234 and jq. Defaults to
 * qwen/qwen3-coder-30b; override with KODR_TEST_MODEL.
 *
 * Deliberately shape-only: a parked run, a red build and an unmet goal are all
 * fine here. What must hold is that the scripts can still *read* the answer.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  checkGoalContract,
  checkRunContract,
  goalIsGreen,
  runIsGreen,
} from '../test/loop-fixtures.mjs';

const LM_STUDIO_URL = 'http://localhost:1234/v1';
const MODEL = process.env.KODR_TEST_MODEL || 'qwen/qwen3-coder-30b';
const KODR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'kodr.mjs',
);

// Budgets: shape-only, so keep every call short. A cold JIT model load still
// dominates, which is why the cases carry their own generous test timeout.
const BUDGET = ['--max-tool-turns', '6', '--max-run-ms', '180000'];

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

function jqAvailable() {
  return spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
}

/** Run a jq filter exactly as the loop scripts do: `printf '%s' "$out" | jq -r '<filter>'`. */
function jq(filter, json) {
  const result = spawnSync('jq', ['-r', filter], {
    input: json,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `jq failed on ${filter}: ${result.stderr}`);
  return result.stdout.trim();
}

function kodr(args, cwd) {
  const result = spawnSync('node', [KODR, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, KODR_MODEL: MODEL },
  });
  return result.stdout ?? '';
}

const skip = (await lmStudioAvailable()) === false && 'LM Studio not available';

describe('loop-script --json contract', {
  skip: skip || (jqAvailable() ? false : 'jq not on PATH'),
}, () => {
  let ws;

  before(async () => {
    ws = await mkdtemp(join(tmpdir(), 'kodr-loop-contract-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
    await writeFile(join(ws, 'hello.txt'), 'hello\n', 'utf8');
  });

  after(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it('kodr run --json still carries every field the ratchet reads', {
    timeout: 600000,
  }, () => {
    const out = kodr(
      [
        'run',
        'add a line saying goodbye to hello.txt',
        '--json',
        '--no-fail',
        ...BUDGET,
      ],
      ws,
    );

    // The scripts pipe stdout straight into jq, so stdout must be JSON alone.
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(out);
    }, `kodr run --json did not print parseable JSON on stdout:\n${out}`);

    assert.deepEqual(
      checkRunContract(parsed),
      [],
      `the ratchet's fields have drifted — loop.sh would read every run as not-green ` +
        `and park the whole backlog. Got: ${JSON.stringify(Object.keys(parsed))}`,
    );

    // Cross-check the real jq expression (examples/loop.sh:137, verbatim) against
    // the same decision computed in JS. Agreement is what proves the expression is
    // reading live fields: on a rename jq quietly answers "false" either way, so
    // the expression alone can't tell drift from a genuinely red run.
    const green = jq(
      '.completed and (.noOpCompletion | not) and (.verified != false)',
      out,
    );
    assert.equal(green, String(runIsGreen(parsed)));

    // examples/loop.sh:139 — drives the backoff branch, so it must never be null.
    assert.notEqual(jq('.stoppedReason // "unknown"', out), 'unknown');
  });

  it("kodr goal --json still answers phased-loop's green expression", {
    timeout: 600000,
  }, () => {
    const out = kodr(
      [
        'goal',
        'hello.txt exists and contains the word hello',
        '--json',
        '--no-fail',
        '--max-attempts',
        '1',
        ...BUDGET,
      ],
      ws,
    );

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(out);
    }, `kodr goal --json did not print parseable JSON on stdout:\n${out}`);

    assert.deepEqual(
      checkGoalContract(parsed),
      [],
      `the GOAL: branch's fields have drifted. Got: ${JSON.stringify(Object.keys(parsed))}`,
    );

    // examples/phased-loop.sh:157, verbatim, cross-checked the same way.
    const green = jq(
      '.met and ((.filesChanged | length) > 0) and (.verified != false)',
      out,
    );
    assert.equal(green, String(goalIsGreen(parsed)));

    // examples/phased-loop.sh:158-160 — both land in the park note.
    assert.notEqual(jq('.reason', out), 'null');
    assert.notEqual(jq('.attempts', out), 'null');
  });
});
