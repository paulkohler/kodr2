import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  exitCodeFor,
  main,
  parseArgs,
  shouldFailProcess,
  summarizeResult,
  visionEnabled,
} from '../src/cli.mjs';

/**
 * Test doubles only ever populate the CliArgs fields a given test exercises;
 * this cast documents that the object is deliberately partial rather than
 * accidentally missing fields.
 * @param {Partial<import('../src/cli.mjs').CliArgs>} partial
 * @returns {import('../src/cli.mjs').CliArgs}
 */
function mockArgs(partial) {
  return /** @type {import('../src/cli.mjs').CliArgs} */ (partial);
}

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

  it('parses --provider flag', () => {
    const args = parseArgs(['run', 'hi', '--provider', 'openrouter']);
    assert.equal(args.provider, 'openrouter');
  });

  it('parses --vision flag (default off)', () => {
    assert.equal(parseArgs(['run', 'hi']).vision, false);
    assert.equal(parseArgs(['run', 'hi', '--vision']).vision, true);
  });

  it('visionEnabled honors the flag then KODR_VISION', () => {
    const original = process.env.KODR_VISION;
    try {
      delete process.env.KODR_VISION;
      assert.equal(visionEnabled(mockArgs({ vision: true })), true);
      assert.equal(visionEnabled(mockArgs({ vision: false })), false);
      process.env.KODR_VISION = '1';
      assert.equal(visionEnabled(mockArgs({ vision: false })), true);
      process.env.KODR_VISION = 'true';
      assert.equal(visionEnabled(mockArgs({ vision: false })), true);
      process.env.KODR_VISION = '0';
      assert.equal(visionEnabled(mockArgs({ vision: false })), false);
    } finally {
      if (original === undefined) {
        delete process.env.KODR_VISION;
      } else {
        process.env.KODR_VISION = original;
      }
    }
  });

  it('defaults --provider to null (createProvider resolves lmstudio)', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.provider, null);
  });

  it('parses --reasoning as a boolean flag', () => {
    const args = parseArgs(['run', 'hi', '--reasoning']);
    assert.equal(args.reasoning, true);
  });

  it('defaults --reasoning to null so KODR_REASONING can still take effect', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.reasoning, null);
  });

  it('parses --openrouter-no-zdr as a boolean flag', () => {
    const args = parseArgs(['run', 'hi', '--openrouter-no-zdr']);
    assert.equal(args.openrouterNoZdr, true);
  });

  it('defaults --openrouter-no-zdr to null so KODR_OPENROUTER_NO_ZDR can still take effect', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.openrouterNoZdr, null);
  });

  it('parses --openrouter-allow-data-collection as a boolean flag', () => {
    const args = parseArgs(['run', 'hi', '--openrouter-allow-data-collection']);
    assert.equal(args.openrouterAllowDataCollection, true);
  });

  it('defaults --openrouter-allow-data-collection to null so KODR_OPENROUTER_ALLOW_DATA_COLLECTION can still take effect', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.openrouterAllowDataCollection, null);
  });

  it('parses --openrouter-provider-only into a list of provider slugs', () => {
    const args = parseArgs([
      'run',
      'hi',
      '--openrouter-provider-only',
      'akashml, parasail',
    ]);
    assert.deepEqual(args.openrouterProviderOnly, ['akashml', 'parasail']);
  });

  it('defaults --openrouter-provider-only to an empty list', () => {
    const args = parseArgs(['run', 'hi']);
    assert.deepEqual(args.openrouterProviderOnly, []);
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

  it('parses --max-tool-turns flag', () => {
    const args = parseArgs(['run', 'hi', '--max-tool-turns', '60']);
    assert.equal(args.maxToolTurns, 60);
  });

  it('defaults --max-tool-turns to 20', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.maxToolTurns, 20);
  });

  it('parses --heartbeat-ms flag', () => {
    const args = parseArgs(['run', 'hi', '--heartbeat-ms', '5000']);
    assert.equal(args.heartbeatMs, 5000);
  });

  it('defaults --heartbeat-ms to 30000', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.heartbeatMs, 30000);
  });

  it('parses --model-retries flag', () => {
    const args = parseArgs(['run', 'hi', '--model-retries', '3']);
    assert.equal(args.modelRetries, 3);
  });

  it('defaults --model-retries to 1', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.modelRetries, 1);
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

  it('parses the "doctor" subcommand without a prompt', () => {
    const args = parseArgs(['doctor']);
    assert.equal(args.command, 'doctor');
    assert.equal(args.prompt, null);
  });

  it('parses the "stats" subcommand without a prompt', () => {
    const args = parseArgs(['stats']);
    assert.equal(args.command, 'stats');
    assert.equal(args.prompt, null);
  });

  it('parses the "replay" subcommand, capturing the ref as a positional', () => {
    const args = parseArgs(['replay', 'last']);
    assert.equal(args.command, 'replay');
    assert.equal(args.prompt, 'last');
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

  it('parses --debug (default false)', () => {
    assert.equal(parseArgs(['run', 'hi', '--debug']).debug, true);
    assert.equal(parseArgs(['run', 'hi']).debug, false);
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

  it('defaults plan off with every plan limit unset', () => {
    const args = parseArgs(['run', 'hi']);
    assert.equal(args.plan, false);
    assert.equal(args.planMaxSteps, null);
    assert.equal(args.planTimeoutMs, null);
    assert.equal(args.planStepMaxToolTurns, null);
    assert.equal(args.planStepMinMs, null);
    assert.equal(args.planSummaryCap, null);
  });

  it('parses --plan-model (default unset)', () => {
    assert.equal(parseArgs(['run', 'hi']).planModel, null);
    const args = parseArgs([
      'run',
      'hi',
      '--plan-model',
      'openrouter/anthropic/claude-opus-4.8',
    ]);
    assert.equal(args.planModel, 'openrouter/anthropic/claude-opus-4.8');
  });

  it('parses --plan and every plan limit flag', () => {
    const args = parseArgs([
      'run',
      'hi',
      '--plan',
      '--plan-max-steps',
      '5',
      '--plan-timeout-ms',
      '30000',
      '--plan-step-max-tool-turns',
      '10',
      '--plan-step-min-ms',
      '15000',
      '--plan-summary-cap',
      '800',
    ]);
    assert.equal(args.plan, true);
    assert.equal(args.planMaxSteps, 5);
    assert.equal(args.planTimeoutMs, 30000);
    assert.equal(args.planStepMaxToolTurns, 10);
    assert.equal(args.planStepMinMs, 15000);
    assert.equal(args.planSummaryCap, 800);
  });
});

describe('--plan validation', () => {
  it('rejects --plan combined with --continue', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await main(['run', 'hi', '--plan', '--continue', 'last']);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('rejects a non-integer plan limit', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await main(['run', 'hi', '--plan-max-steps', 'lots']);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('rejects --plan-model combined with --continue (a plan model implies --plan)', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await main([
        'run',
        'hi',
        '--plan-model',
        'big-planner',
        '--continue',
        'last',
      ]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

/**
 * summarizeResult's own JSDoc return type is the generic `object`, so this
 * cast documents the real shape it builds (see src/cli.mjs) for the call
 * sites below.
 * @typedef {object} ResultSummary
 * @property {string} [stoppedReason]
 * @property {boolean} completed
 * @property {number} toolTurns
 * @property {{ prompt: number, completion: number, cost: number }} usage
 * @property {number} compactions
 * @property {number} retries
 * @property {boolean|null} healed
 * @property {number|null} healTurns
 * @property {boolean|null} verified
 * @property {boolean} noOpCompletion
 * @property {string[]} filesChanged
 * @property {string[]} packageCommands
 * @property {string} response
 * @property {string|null} error
 * @property {{ raw?: object, fix?: object }|null} commits
 * @property {import('../src/review.mjs').ReviewResult|{skipped:true,reason:string}|null} review
 * @property {import('../src/plan.mjs').Plan|null} plan
 */

/**
 * @param {import('../src/harness.mjs').RunResult} result
 * @returns {ResultSummary}
 */
function summarize(result) {
  return /** @type {ResultSummary} */ (summarizeResult(result));
}

describe('summarizeResult', () => {
  it('produces a compact machine-readable summary', () => {
    const summary = summarize({
      stoppedReason: 'complete',
      toolTurns: 5,
      usage: { prompt: 100, completion: 20, cost: 0 },
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
    assert.equal(summary.noOpCompletion, false);
    assert.equal(summary.retries, 0);
  });

  it('marks incomplete runs and surfaces errors', () => {
    const summary = summarize({
      stoppedReason: 'error',
      error: { message: 'HTTP 500' },
    });
    assert.equal(summary.completed, false);
    assert.equal(summary.verified, null);
    assert.equal(summary.error, 'HTTP 500');
  });

  it('surfaces a no-op completion', () => {
    const summary = summarize({
      stoppedReason: 'complete',
      noOpCompletion: true,
      filesChanged: [],
    });
    assert.equal(summary.noOpCompletion, true);
  });

  it('surfaces the total retries count', () => {
    const summary = summarize({ stoppedReason: 'complete', retries: 3 });
    assert.equal(summary.retries, 3);
  });

  it('defaults review to null when absent', () => {
    const summary = summarize({ stoppedReason: 'complete' });
    assert.equal(summary.review, null);
  });

  it('surfaces the plan when present, null otherwise', () => {
    assert.equal(summarize({ stoppedReason: 'complete' }).plan, null);
    const plan = /** @type {import('../src/plan.mjs').Plan} */ ({
      createdAt: 't',
      degraded: false,
      steps: [],
    });
    assert.equal(summarize({ stoppedReason: 'complete', plan }).plan, plan);
  });

  it('surfaces a completed review pass', () => {
    const summary = summarize({
      stoppedReason: 'complete',
      review: /** @type {import('../src/review.mjs').ReviewResult} */ ({
        findings: 'No findings.',
        grounded: true,
      }),
    });
    assert.deepEqual(summary.review, {
      findings: 'No findings.',
      grounded: true,
    });
  });

  it('distinguishes a review skipped for an incomplete build from no review configured at all', () => {
    const noReview = summarize({ stoppedReason: 'error' });
    const skippedReview = summarize({
      stoppedReason: 'error',
      review: {
        skipped: true,
        reason: 'build did not complete (stoppedReason: error)',
      },
    });
    assert.equal(noReview.review, null);
    assert.equal(skippedReview.review.skipped, true);
  });
});

describe('exitCodeFor', () => {
  it('returns 1 for an incomplete run by default', () => {
    assert.equal(
      exitCodeFor({ stoppedReason: 'budget-exceeded' }, mockArgs({})),
      1,
    );
  });

  it('returns 0 for a completed run', () => {
    assert.equal(exitCodeFor({ stoppedReason: 'complete' }, mockArgs({})), 0);
  });

  it('returns 0 even for failure when --no-fail is set', () => {
    assert.equal(
      exitCodeFor(
        { stoppedReason: 'budget-exceeded' },
        mockArgs({ noFail: true }),
      ),
      0,
    );
    assert.equal(
      exitCodeFor(
        { verification: { passed: false } },
        mockArgs({ noFail: true }),
      ),
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

describe('kodr models', () => {
  it('reports a clean error instead of an unhandled rejection when the provider is unreachable (non-rich provider)', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      // Reproduces the exact repro from review: an unreachable ollama
      // (non-rich; goes through client.models(), not richModels()) used to
      // crash with a raw Node stack trace instead of a clean CLI error.
      await assert.doesNotReject(
        main([
          'models',
          '--provider',
          'ollama',
          '--base-url',
          'http://127.0.0.1:1/v1',
        ]),
      );
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
