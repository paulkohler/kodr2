import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exitCodeFor,
  parseArgs,
  shouldFailProcess,
  summarizeResult,
} from '../src/cli.mjs';

describe('parseArgs', () => {
  it('extracts prompt from "run" command', () => {
    const args = parseArgs(['run', 'fix the bug']);
    assert.equal(args.prompt, 'fix the bug');
    assert.equal(args.command, 'run');
  });

  it('extracts prompt from shorthand (no command)', () => {
    const args = parseArgs(['fix the bug']);
    assert.equal(args.prompt, 'fix the bug');
  });

  it('parses --cwd flag', () => {
    const args = parseArgs(['run', 'do stuff', '--cwd', '/tmp/project']);
    assert.equal(args.cwd, '/tmp/project');
    assert.equal(args.prompt, 'do stuff');
  });

  it('parses --base-url flag', () => {
    const args = parseArgs(['run', 'hi', '--base-url', 'http://other:5000/v1']);
    assert.equal(args.baseUrl, 'http://other:5000/v1');
  });

  it('parses --model flag', () => {
    const args = parseArgs(['run', 'hi', '--model', 'qwen/qwen3']);
    assert.equal(args.model, 'qwen/qwen3');
  });

  it('parses --test flag', () => {
    const args = parseArgs(['run', 'hi', '--test', 'npm test']);
    assert.equal(args.test, 'npm test');
  });

  it('parses --prompt flag', () => {
    const args = parseArgs(['run', '--prompt', 'fix the bug']);
    assert.equal(args.prompt, 'fix the bug');
    assert.equal(args.command, 'run');
  });

  it('parses -p shorthand', () => {
    const args = parseArgs(['run', '-p', 'fix the bug']);
    assert.equal(args.prompt, 'fix the bug');
    assert.equal(args.command, 'run');
  });

  it('parses --heal-turns flag', () => {
    const args = parseArgs(['run', 'hi', '--heal-turns', '5']);
    assert.equal(args.healTurns, 5);
  });

  it('parses --max-run-ms flag', () => {
    const args = parseArgs(['run', 'hi', '--max-run-ms', '1000']);
    assert.equal(args.maxRunMs, 1000);
  });

  it('parses --context-window flag', () => {
    const args = parseArgs(['run', 'hi', '--context-window', '32768']);
    assert.equal(args.contextWindow, 32768);
  });

  it('defaults context window to null (harness resolves it)', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.contextWindow, null);
  });

  it('parses the "models" subcommand without a prompt', () => {
    const args = parseArgs(['models']);
    assert.equal(args.command, 'models');
    assert.equal(args.prompt, null);
  });

  it('treats "/compact" as the prompt', () => {
    const args = parseArgs(['/compact']);
    assert.equal(args.prompt, '/compact');
    assert.equal(args.command, 'run');
  });

  it('parses --quiet flag', () => {
    const args = parseArgs(['run', 'hi', '--quiet']);
    assert.equal(args.quiet, true);
  });

  it('parses -q shorthand', () => {
    const args = parseArgs(['run', 'hi', '-q']);
    assert.equal(args.quiet, true);
  });

  it('parses --continue flag', () => {
    const args = parseArgs(['run', 'hi', '--continue', 'last']);
    assert.equal(args.continue, 'last');
  });

  it('parses --env into a list of names', () => {
    const args = parseArgs(['run', 'hi', '--env', 'API_URL, CI ,API_URL']);
    assert.deepEqual(args.env, ['API_URL', 'CI']);
  });

  it('parses --runs-dir and --no-save', () => {
    const args = parseArgs([
      'run',
      'hi',
      '--runs-dir',
      '/tmp/jobs',
      '--no-save',
    ]);
    assert.equal(args.runsDir, '/tmp/jobs');
    assert.equal(args.noSave, true);
  });

  it('defaults runs-dir to null and no-save to false', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.runsDir, null);
    assert.equal(args.noSave, false);
  });

  it('parses --json (default false)', () => {
    assert.equal(parseArgs(['run', 'hi', '--json']).json, true);
    assert.equal(parseArgs(['run', 'hi']).json, false);
  });

  it('parses --no-fail (default false)', () => {
    assert.equal(parseArgs(['run', 'hi', '--no-fail']).noFail, true);
    assert.equal(parseArgs(['run', 'hi']).noFail, false);
  });

  it('defaults env to an empty list', () => {
    const args = parseArgs(['run', 'hi']);
    assert.deepEqual(args.env, []);
  });

  it('parses --help flag', () => {
    const args = parseArgs(['--help']);
    assert.equal(args.help, true);
  });

  it('parses --version flag', () => {
    const args = parseArgs(['-v']);
    assert.equal(args.version, true);
  });

  it('defaults heal turns to 3', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.healTurns, 3);
  });

  it('defaults quiet to false', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.quiet, false);
  });
});

describe('summarizeResult', () => {
  it('produces a compact machine-readable summary', () => {
    const summary = summarizeResult({
      stoppedReason: 'complete',
      toolTurns: 5,
      usage: { prompt: 100, completion: 20 },
      healed: true,
      healTurns: 2,
      verification: { passed: true },
      filesChanged: ['server.js'],
      packageCommands: [],
      response: 'done',
    });
    assert.equal(summary.completed, true);
    assert.equal(summary.verified, true);
    assert.equal(summary.healed, true);
    assert.equal(summary.toolTurns, 5);
    assert.deepEqual(summary.filesChanged, ['server.js']);
    assert.equal(summary.error, null);
  });

  it('marks incomplete runs and surfaces errors', () => {
    const summary = summarizeResult({
      stoppedReason: 'error',
      error: { message: 'HTTP 500' },
    });
    assert.equal(summary.completed, false);
    assert.equal(summary.verified, null);
    assert.equal(summary.error, 'HTTP 500');
  });
});

describe('exitCodeFor', () => {
  it('returns 1 for an incomplete run by default', () => {
    assert.equal(exitCodeFor({ stoppedReason: 'budget-exceeded' }, {}), 1);
  });

  it('returns 0 for a completed run', () => {
    assert.equal(exitCodeFor({ stoppedReason: 'complete' }, {}), 0);
  });

  it('returns 0 even for failure when --no-fail is set', () => {
    assert.equal(
      exitCodeFor({ stoppedReason: 'budget-exceeded' }, { noFail: true }),
      0,
    );
    assert.equal(
      exitCodeFor({ verification: { passed: false } }, { noFail: true }),
      0,
    );
  });
});

describe('shouldFailProcess', () => {
  it('fails the CLI process when verification failed', () => {
    assert.equal(shouldFailProcess({ verification: { passed: false } }), true);
  });

  it('does not fail the CLI process when verification passed', () => {
    assert.equal(shouldFailProcess({ verification: { passed: true } }), false);
  });

  it('does not fail the CLI process when verification did not run', () => {
    assert.equal(shouldFailProcess({}), false);
  });

  it('fails the CLI process when the run did not complete', () => {
    assert.equal(shouldFailProcess({ stoppedReason: 'budget-exceeded' }), true);
  });
});
