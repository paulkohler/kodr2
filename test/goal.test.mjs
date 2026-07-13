import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseArgs } from '../src/cli.mjs';
import {
  buildRetryPrompt,
  evaluateGoal,
  goalMaxAttempts,
  judgeMaxToolTurns,
  judgeMinToolCalls,
  parseVerdict,
  runGoal,
  summarizeGoalResult,
} from '../src/goal.mjs';
import { createNullReporter } from '../src/reporter.mjs';

const silentReporter = createNullReporter();

// --- Fakes for the pure loop (runGoal). runTask/evaluate are injected
// collaborators, not model mocks: the loop control is exercised with plain
// return values, and the model-backed judge is covered separately below.

function fakeResult(over = {}) {
  return {
    stoppedReason: 'complete',
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

function verdict(over = {}) {
  return {
    met: false,
    grounded: true,
    feedback: 'not yet',
    toolTurns: 2,
    usage: { prompt: 3, completion: 2, cost: 0 },
    retries: 0,
    ...over,
  };
}

describe('runGoal', () => {
  it('stops on the first met-and-grounded verdict and reports reason "met"', async () => {
    let taskCalls = 0;
    const result = await runGoal({
      goal: 'g',
      maxAttempts: 3,
      runTask: async () => {
        taskCalls += 1;
        return fakeResult();
      },
      evaluate: async () => verdict({ met: true, grounded: true }),
    });
    assert.equal(result.met, true);
    assert.equal(result.reason, 'met');
    assert.equal(result.attempts, 1);
    assert.equal(taskCalls, 1);
  });

  it('retries with continuation carrying the prior judge feedback when not met', async () => {
    const prompts = [];
    const continuations = [];
    const verdicts = [
      verdict({ met: false, feedback: 'add a test' }),
      verdict({ met: true }),
    ];
    let n = 0;
    const result = await runGoal({
      goal: 'ship X',
      maxAttempts: 3,
      runTask: async (prompt, continuation) => {
        prompts.push(prompt);
        continuations.push(continuation);
        return fakeResult();
      },
      evaluate: async () => verdicts[n++],
    });
    assert.equal(result.met, true);
    assert.equal(result.attempts, 2);
    assert.equal(prompts[0], 'ship X');
    assert.equal(continuations[0], null);
    assert.match(prompts[1], /add a test/);
    assert.match(prompts[1], /ship X/);
    assert.ok(
      continuations[1] && Array.isArray(continuations[1].priorMessages),
    );
    assert.deepEqual(continuations[1].priorFilesChanged, ['a.mjs']);
  });

  it('caps at maxAttempts and reports reason "exhausted"', async () => {
    let taskCalls = 0;
    const result = await runGoal({
      goal: 'g',
      maxAttempts: 2,
      runTask: async () => {
        taskCalls += 1;
        return fakeResult();
      },
      evaluate: async () => verdict({ met: false }),
    });
    assert.equal(result.met, false);
    assert.equal(result.reason, 'exhausted');
    assert.equal(result.attempts, 2);
    assert.equal(taskCalls, 2);
  });

  it('does not stop on an ungrounded "met" verdict, it keeps iterating', async () => {
    const verdicts = [
      verdict({ met: true, grounded: false }),
      verdict({ met: true, grounded: true }),
    ];
    let n = 0;
    const result = await runGoal({
      goal: 'g',
      maxAttempts: 3,
      runTask: async () => fakeResult(),
      evaluate: async () => verdicts[n++],
    });
    assert.equal(result.attempts, 2);
    assert.equal(result.met, true);
    assert.equal(result.reason, 'met');
  });

  it('preserves an ungrounded final verdict but reports the overall result met:false', async () => {
    const result = await runGoal({
      goal: 'g',
      maxAttempts: 1,
      runTask: async () => fakeResult(),
      evaluate: async () => verdict({ met: true, grounded: false }),
    });
    assert.equal(result.met, false);
    assert.equal(result.reason, 'exhausted');
    assert.equal(result.attempts, 1);
    assert.equal(result.verdicts[0].met, true);
    assert.equal(result.verdicts[0].grounded, false);
  });

  it('stops with reason "stalled" after two consecutive no-file-change attempts', async () => {
    let taskCalls = 0;
    const result = await runGoal({
      goal: 'g',
      maxAttempts: 5,
      runTask: async () => {
        taskCalls += 1;
        return fakeResult({ filesChanged: [] });
      },
      evaluate: async () => verdict({ met: false }),
    });
    assert.equal(result.reason, 'stalled');
    assert.equal(result.attempts, 2);
    assert.equal(taskCalls, 2);
  });

  it('stops with reason "build-error" without judging when a build attempt errors', async () => {
    let judged = 0;
    const result = await runGoal({
      goal: 'g',
      maxAttempts: 3,
      runTask: async () => fakeResult({ stoppedReason: 'error' }),
      evaluate: async () => {
        judged += 1;
        return verdict();
      },
    });
    assert.equal(result.reason, 'build-error');
    assert.equal(result.met, false);
    assert.equal(result.attempts, 1);
    assert.equal(judged, 0);
  });

  it('sums build and judge usage and retries', async () => {
    const verdicts = [
      verdict({
        met: false,
        usage: { prompt: 3, completion: 2, cost: 0 },
        retries: 1,
      }),
      verdict({
        met: true,
        usage: { prompt: 4, completion: 1, cost: 0 },
        retries: 0,
      }),
    ];
    let n = 0;
    const result = await runGoal({
      goal: 'g',
      maxAttempts: 3,
      runTask: async () =>
        fakeResult({
          usage: { prompt: 10, completion: 5, cost: 0 },
          retries: 2,
        }),
      evaluate: async () => verdicts[n++],
    });
    assert.equal(result.usage.prompt, 10 + 10 + 3 + 4);
    assert.equal(result.usage.completion, 5 + 5 + 2 + 1);
    assert.equal(result.retries, 2 + 2 + 1 + 0);
  });
});

describe('buildRetryPrompt', () => {
  it('frames the judge feedback and restates the goal', () => {
    const p = buildRetryPrompt('ship X', 'missing a test');
    assert.match(p, /not yet met/i);
    assert.match(p, /missing a test/);
    assert.match(p, /ship X/);
  });

  it('still restates the goal when there is no feedback', () => {
    const p = buildRetryPrompt('ship X', '');
    assert.match(p, /not yet met/i);
    assert.match(p, /ship X/);
  });
});

describe('parseVerdict', () => {
  it('reads "VERDICT: MET" as met', () => {
    assert.equal(parseVerdict('Looks complete.\nVERDICT: MET').met, true);
  });

  it('reads "VERDICT: NOT MET" as not met', () => {
    assert.equal(parseVerdict('Missing a test.\nVERDICT: NOT MET').met, false);
  });

  it('treats a missing or garbled verdict as not met, never a false success', () => {
    assert.equal(parseVerdict('I think it is basically fine').met, false);
    assert.equal(parseVerdict('').met, false);
    assert.equal(parseVerdict('VERD: MET maybe').met, false);
  });

  it('returns the reply text with the verdict line stripped as feedback', () => {
    const v = parseVerdict('The route lacks a test.\nVERDICT: NOT MET');
    assert.equal(v.feedback, 'The route lacks a test.');
  });
});

describe('goalMaxAttempts', () => {
  const envKey = 'KODR_GOAL_MAX_ATTEMPTS';
  let original;
  beforeEach(() => {
    original = process.env[envKey];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = original;
    }
  });

  it('prefers an explicit option', () => {
    process.env[envKey] = '9';
    assert.equal(goalMaxAttempts(4), 4);
  });
  it('falls back to KODR_GOAL_MAX_ATTEMPTS', () => {
    process.env[envKey] = '9';
    assert.equal(goalMaxAttempts(undefined), 9);
  });
  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(goalMaxAttempts(undefined), 3);
  });
});

describe('judgeMinToolCalls', () => {
  const envKey = 'KODR_GOAL_JUDGE_MIN_TOOL_CALLS';
  let original;
  beforeEach(() => {
    original = process.env[envKey];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = original;
    }
  });

  it('prefers an explicit option', () => {
    process.env[envKey] = '5';
    assert.equal(judgeMinToolCalls(3), 3);
  });
  it('falls back to the env var', () => {
    process.env[envKey] = '5';
    assert.equal(judgeMinToolCalls(undefined), 5);
  });
  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(judgeMinToolCalls(undefined), 1);
  });
});

describe('judgeMaxToolTurns', () => {
  const envKey = 'KODR_GOAL_JUDGE_MAX_TOOL_TURNS';
  let original;
  beforeEach(() => {
    original = process.env[envKey];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = original;
    }
  });

  it('prefers an explicit option', () => {
    process.env[envKey] = '5';
    assert.equal(judgeMaxToolTurns(7), 7);
  });
  it('falls back to the env var', () => {
    process.env[envKey] = '5';
    assert.equal(judgeMaxToolTurns(undefined), 5);
  });
  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(judgeMaxToolTurns(undefined), 12);
  });
});

// --- The model-backed judge (evaluateGoal). Same scripted-client pattern
// review.test.mjs uses: a client that returns queued chat responses in order.

function scriptedClient(responses) {
  const calls = [];
  let i = 0;
  return /** @type {any} */ ({
    calls,
    async chat(params) {
      calls.push(params);
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    },
  });
}

function toolCallTurn(name, args) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `call_${Math.random()}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { prompt: 1, completion: 1, cost: 0 },
  };
}

function finalTurn(text) {
  return {
    message: { role: 'assistant', content: text },
    usage: { prompt: 2, completion: 3, cost: 0 },
  };
}

describe('evaluateGoal', () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kodr-goal-'));
    await writeFile(join(tmpDir, 'a.mjs'), 'export const x = 1;\n');
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('runs a read-only tool loop and parses the verdict from the final turn', async () => {
    const client = scriptedClient([
      toolCallTurn('read_file', { path: 'a.mjs' }),
      finalTurn('Checked the file.\nVERDICT: MET'),
    ]);
    const v = await evaluateGoal({
      reporter: silentReporter,
      client,
      modelId: 'judge',
      cwd: tmpDir,
      goal: 'x is exported',
      filesChanged: ['a.mjs'],
    });
    assert.equal(v.met, true);
    assert.equal(v.grounded, true);
    assert.equal(v.toolTurns, 1);
  });

  it('marks a zero-tool-call verdict ungrounded', async () => {
    const client = scriptedClient([finalTurn('VERDICT: MET')]);
    const v = await evaluateGoal({
      reporter: silentReporter,
      client,
      modelId: 'judge',
      cwd: tmpDir,
      goal: 'x is exported',
      filesChanged: ['a.mjs'],
    });
    assert.equal(v.met, true);
    assert.equal(v.grounded, false);
    assert.equal(v.toolTurns, 0);
  });

  it('restricts the tool registry so write_file/edit_file/run_command are unavailable', async () => {
    const client = scriptedClient([
      toolCallTurn('write_file', {
        path: 'a.mjs',
        content: 'export const x = 2;\n',
      }),
      finalTurn('VERDICT: NOT MET'),
    ]);
    await evaluateGoal({
      reporter: silentReporter,
      client,
      modelId: 'judge',
      cwd: tmpDir,
      goal: 'x is exported',
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
      maxToolTurns: 1,
    });
    const content = await readFile(join(tmpDir, 'a.mjs'), 'utf8');
    assert.equal(content, 'export const x = 1;\n');
  });

  it('the judge system prompt states the read-only tool set, the verdict format, and grounding', async () => {
    const client = scriptedClient([finalTurn('VERDICT: NOT MET')]);
    await evaluateGoal({
      reporter: silentReporter,
      client,
      modelId: 'judge',
      cwd: tmpDir,
      goal: 'x is exported',
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });
    const system = client.calls[0].messages.find(
      (m) => m.role === 'system',
    ).content;
    assert.match(system, /read-only/);
    assert.match(system, /VERDICT: MET/);
    assert.match(system, /VERDICT: NOT MET/);
    assert.match(system, /without opening a file/);
  });

  it('does not crash under a run budget when no startedAt is supplied', async () => {
    // With maxRunMs set, the tool loop's budget check reads startedAt.getTime();
    // evaluateGoal must default startedAt so a caller can omit it (regression:
    // a live --max-run-ms goal run threw "Cannot read properties of undefined").
    const client = scriptedClient([finalTurn('VERDICT: MET')]);
    const v = await evaluateGoal({
      reporter: silentReporter,
      client,
      modelId: 'judge',
      cwd: tmpDir,
      goal: 'x is exported',
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
      maxRunMs: 60000,
    });
    assert.equal(v.met, true);
  });
});

describe('summarizeGoalResult', () => {
  it('produces a compact machine-readable summary', () => {
    const gr = {
      met: true,
      reason: 'met',
      attempts: 2,
      usage: { prompt: 1, completion: 2, cost: 0 },
      retries: 1,
      verdicts: [verdict({ met: false }), verdict({ met: true })],
      lastResult: {
        stoppedReason: 'complete',
        verification: { passed: true },
        filesChanged: ['a.mjs'],
        response: 'ok',
      },
    };
    const s = summarizeGoalResult(gr);
    assert.equal(s.met, true);
    assert.equal(s.reason, 'met');
    assert.equal(s.attempts, 2);
    assert.equal(s.stoppedReason, 'complete');
    assert.equal(s.verified, true);
    assert.deepEqual(s.filesChanged, ['a.mjs']);
    assert.equal(s.verdicts.length, 2);
    assert.deepEqual(s.verdicts[1], { met: true, grounded: true });
  });
});

describe('parseArgs (goal)', () => {
  it('parses the goal subcommand, the goal text, and --max-attempts', () => {
    const a = parseArgs([
      'goal',
      'the route is documented',
      '--max-attempts',
      '5',
    ]);
    assert.equal(a.command, 'goal');
    assert.equal(a.prompt, 'the route is documented');
    assert.equal(a.maxAttempts, 5);
  });
});
