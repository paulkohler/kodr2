import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_PLAN_MAX_STEPS,
  DEFAULT_PLAN_TIMEOUT_MS,
  DEFAULT_STEP_MIN_MS,
  DEFAULT_STEP_SUMMARY_CAP,
  buildStepMessages,
  createPlan,
  fallbackPlan,
  parsePlanResponse,
  planEnabled,
  planMaxSteps,
  planModelSpec,
  planTimeoutMs,
  runStep,
  stepMaxToolTurns,
  stepMinMs,
  stepRunMs,
  stepSummaryCap,
} from '../src/plan.mjs';

// A scripted model client: returns queued responses in order, repeating the
// last one once the queue is drained. Matches this repo's per-file
// test-double style (see review.test.mjs).
/**
 * @param {Array<object|Error>} responses
 * @returns {import('../src/provider.mjs').Provider & { calls: Array<any> }}
 */
function scriptedClient(responses) {
  const calls = [];
  let i = 0;
  return /** @type {import('../src/provider.mjs').Provider & { calls: Array<any> }} */ (
    /** @type {any} */ ({
      calls,
      async chat(params) {
        calls.push(params);
        const response = responses[Math.min(i, responses.length - 1)];
        i++;
        if (response instanceof Error) {
          throw response;
        }
        return response;
      },
    })
  );
}

function planReply(content, usage) {
  return {
    message: { role: 'assistant', content },
    usage: usage || { prompt: 10, completion: 5, cost: 0 },
    retries: 0,
  };
}

const TWO_STEPS =
  '{"steps":[{"title":"First","description":"do first"},{"title":"Second","description":"do second"}]}';

describe('parsePlanResponse', () => {
  const opts = { maxSteps: 8 };

  it('accepts a bare JSON object', () => {
    const result = parsePlanResponse(TWO_STEPS, opts);
    assert.equal(result.error, undefined);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].title, 'First');
    assert.equal(result.steps[1].description, 'do second');
  });

  it('accepts fenced JSON', () => {
    const result = parsePlanResponse(
      `Here you go:\n\`\`\`json\n${TWO_STEPS}\n\`\`\``,
      opts,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.steps.length, 2);
  });

  it('accepts prose-wrapped JSON', () => {
    const result = parsePlanResponse(
      `The plan is as follows: ${TWO_STEPS} — good luck!`,
      opts,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.steps.length, 2);
  });

  it('rejects a reply with no JSON object', () => {
    assert.match(parsePlanResponse('no json here', opts).error, /no JSON/);
    assert.match(parsePlanResponse('', opts).error, /no JSON/);
  });

  it('rejects unbalanced JSON', () => {
    assert.match(
      parsePlanResponse('{"steps":[{"title":"a"', opts).error,
      /unbalanced/,
    );
  });

  it('rejects a reply without a steps array', () => {
    assert.match(parsePlanResponse('{"plan":[]}', opts).error, /steps array/);
    assert.match(
      parsePlanResponse('{"steps":"not an array"}', opts).error,
      /steps array/,
    );
  });

  it('rejects zero steps', () => {
    assert.match(parsePlanResponse('{"steps":[]}', opts).error, /zero steps/);
  });

  it('rejects a step count over maxSteps rather than truncating', () => {
    const steps = Array.from({ length: 3 }, (_, i) => ({
      title: `t${i}`,
      description: `d${i}`,
    }));
    const result = parsePlanResponse(JSON.stringify({ steps }), {
      maxSteps: 2,
    });
    assert.match(result.error, /3 steps \(max 2\)/);
  });

  it('rejects non-object steps and missing or non-string fields', () => {
    assert.match(
      parsePlanResponse('{"steps":["just a string"]}', opts).error,
      /not an object/,
    );
    assert.match(
      parsePlanResponse('{"steps":[{"description":"d"}]}', opts).error,
      /missing a title/,
    );
    assert.match(
      parsePlanResponse('{"steps":[{"title":"  ","description":"d"}]}', opts)
        .error,
      /missing a title/,
    );
    assert.match(
      parsePlanResponse('{"steps":[{"title":"t","description":42}]}', opts)
        .error,
      /missing a description/,
    );
  });

  it('truncates over-length titles and descriptions', () => {
    const step = { title: 'x'.repeat(500), description: 'y'.repeat(10_000) };
    const result = parsePlanResponse(JSON.stringify({ steps: [step] }), opts);
    assert.equal(result.steps[0].title.length, 200);
    assert.equal(result.steps[0].description.length, 4_000);
  });
});

describe('fallbackPlan', () => {
  it('yields a single-step degraded plan carrying the whole prompt', () => {
    const plan = fallbackPlan('build the thing');
    assert.equal(plan.degraded, true);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].id, 1);
    assert.equal(plan.steps[0].description, 'build the thing');
    assert.equal(plan.steps[0].status, 'pending');
    assert.equal(plan.steps[0].summary, '');
  });
});

describe('createPlan', () => {
  it('returns a validated plan from a well-formed reply', async () => {
    const client = scriptedClient([planReply(TWO_STEPS)]);
    const result = await createPlan({
      client,
      modelId: 'm',
      prompt: 'do two things',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.plan.degraded, false);
    assert.deepEqual(
      result.plan.steps.map((s) => [s.id, s.title, s.status]),
      [
        [1, 'First', 'pending'],
        [2, 'Second', 'pending'],
      ],
    );
    assert.deepEqual(result.usage, { prompt: 10, completion: 5, cost: 0 });
  });

  it('sends the plan system prompt with the step cap and the prompt verbatim', async () => {
    const client = scriptedClient([planReply(TWO_STEPS)]);
    await createPlan({
      client,
      modelId: 'm',
      prompt: 'the raw task',
      maxSteps: 3,
    });
    const { messages, tools } = client.calls[0];
    assert.equal(tools, undefined);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /at most 3 steps/);
    assert.deepEqual(messages[1], { role: 'user', content: 'the raw task' });
  });

  it('degrades to the fallback plan when the chat call throws', async () => {
    const err = Object.assign(new Error('connection refused'), { retries: 2 });
    const client = scriptedClient([err]);
    const result = await createPlan({ client, modelId: 'm', prompt: 'task' });
    assert.equal(result.plan.degraded, true);
    assert.equal(result.plan.steps.length, 1);
    assert.equal(result.plan.steps[0].description, 'task');
    assert.equal(result.error, 'connection refused');
    assert.equal(result.retries, 2);
  });

  it('degrades to the fallback plan (preserving usage) on an unparseable reply', async () => {
    const client = scriptedClient([
      planReply('I would suggest starting with the tests.'),
    ]);
    const result = await createPlan({ client, modelId: 'm', prompt: 'task' });
    assert.equal(result.plan.degraded, true);
    assert.match(result.error, /no JSON/);
    assert.deepEqual(result.usage, { prompt: 10, completion: 5, cost: 0 });
  });

  it('degrades to the fallback plan when the plan is over the step cap', async () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({
      title: `t${i}`,
      description: `d${i}`,
    }));
    const client = scriptedClient([planReply(JSON.stringify({ steps }))]);
    const result = await createPlan({ client, modelId: 'm', prompt: 'task' });
    assert.equal(result.plan.degraded, true);
    assert.match(result.error, /9 steps \(max 8\)/);
  });

  it('clamps the planner timeout to the remaining run budget', async () => {
    const client = scriptedClient([planReply(TWO_STEPS)]);
    await createPlan({
      client,
      modelId: 'm',
      prompt: 'task',
      startedAt: new Date(),
      maxRunMs: 5_000,
    });
    assert.ok(client.calls[0].timeoutMs <= 5_000);
  });

  it('passes no timeout when the cap is disabled and there is no run budget', async () => {
    const client = scriptedClient([planReply(TWO_STEPS)]);
    await createPlan({
      client,
      modelId: 'm',
      prompt: 'task',
      timeoutMs: 0,
    });
    assert.equal(client.calls[0].timeoutMs, undefined);
  });
});

describe('stepRunMs', () => {
  it('returns 0 when the run has no budget', () => {
    assert.equal(
      stepRunMs({ maxRunMs: 0, stepsRemaining: 3, floorMs: 1_000 }),
      0,
    );
  });

  it('splits the remaining budget equally over the remaining steps', () => {
    const result = stepRunMs({
      startedAt: new Date(),
      maxRunMs: 100_000,
      stepsRemaining: 4,
      floorMs: 1_000,
    });
    // elapsed ~0, share = 25s
    assert.ok(result > 24_000 && result < 26_000, `got ${result}`);
  });

  it('recomputes from actual remaining time so a fast early step donates leftovers', () => {
    const startedAt = new Date(Date.now() - 10_000);
    const result = stepRunMs({
      startedAt,
      maxRunMs: 100_000,
      stepsRemaining: 3,
      floorMs: 0,
    });
    // elapsed ~10s, share = 90s/3 = 30s -> deadline ~40s
    assert.ok(result > 39_000 && result < 41_000, `got ${result}`);
  });

  it('applies the floor but clamps to the real run budget', () => {
    const startedAt = new Date(Date.now() - 99_000);
    const result = stepRunMs({
      startedAt,
      maxRunMs: 100_000,
      stepsRemaining: 2,
      floorMs: 60_000,
    });
    // floor would allow 60s more, but the run budget wins
    assert.equal(result, 100_000);
  });
});

/**
 * A minimal fake ToolRegistry with the surface runStep touches.
 * @param {string[]} [files]
 * @returns {import('../src/tools/index.mjs').ToolRegistry}
 */
function fakeTools(files = []) {
  return /** @type {import('../src/tools/index.mjs').ToolRegistry} */ (
    /** @type {any} */ ({
      definitions: () => [],
      dispatch: async () => ({ ok: true }),
      filesChanged: () => files,
    })
  );
}

/** @returns {import('../src/plan.mjs').Plan} */
function samplePlan() {
  return /** @type {import('../src/plan.mjs').Plan} */ ({
    createdAt: '2026-07-11T00:00:00.000Z',
    degraded: false,
    steps: [
      {
        id: 1,
        title: 'Set up',
        description: 'create the repo',
        status: 'done',
        stoppedReason: 'complete',
        summary: 'repo created at /git/project',
        toolTurns: 3,
      },
      {
        id: 2,
        title: 'Write hook',
        description: 'add the post-receive hook',
        status: 'failed',
        stoppedReason: 'tool-limit',
        summary: 'ran out of turns mid-edit',
        toolTurns: 20,
      },
      {
        id: 3,
        title: 'Configure nginx',
        description: 'serve both branches over https',
        status: 'pending',
        stoppedReason: null,
        summary: '',
        toolTurns: 0,
      },
    ],
  });
}

describe('buildStepMessages', () => {
  it('composes the build system prompt plus the plan-step addendum', () => {
    const [system] = buildStepMessages({
      systemPrompt: 'THE BUILD PROMPT',
      goal: 'the goal',
      plan: samplePlan(),
      step: samplePlan().steps[2],
    });
    assert.equal(system.role, 'system');
    assert.ok(system.content.startsWith('THE BUILD PROMPT'));
    assert.match(system.content, /ONE step of a fixed plan/);
  });

  it('carries goal, plan statuses, handoffs, files changed, and the assigned step', () => {
    const plan = samplePlan();
    const [, user] = buildStepMessages({
      systemPrompt: 'sys',
      goal: 'set up a git server',
      plan,
      step: plan.steps[2],
      filesChanged: ['hooks/post-receive'],
    });
    assert.equal(user.role, 'user');
    assert.match(user.content, /Overall goal:\nset up a git server/);
    assert.match(user.content, /1\. \[done\] Set up — repo created/);
    assert.match(
      user.content,
      /2\. \[failed: tool-limit\] Write hook — ran out/,
    );
    assert.match(user.content, /3\. \[YOUR STEP\] Configure nginx/);
    assert.match(user.content, /- hooks\/post-receive/);
    assert.match(
      user.content,
      /Your step \(3 of 3\): Configure nginx\nserve both branches over https/,
    );
  });

  it('marks pending steps and shows (none yet) when nothing changed', () => {
    const plan = samplePlan();
    const [, user] = buildStepMessages({
      systemPrompt: 'sys',
      goal: 'g',
      plan,
      step: plan.steps[0],
    });
    assert.match(user.content, /1\. \[YOUR STEP\] Set up/);
    assert.match(user.content, /3\. \[pending\] Configure nginx/);
    assert.match(user.content, /\(none yet\)/);
  });
});

describe('runStep', () => {
  function finalTurn(content) {
    return {
      message: { role: 'assistant', content },
      usage: { prompt: 7, completion: 3, cost: 0 },
      retries: 1,
    };
  }

  function toolTurn() {
    return {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      usage: { prompt: 5, completion: 2, cost: 0 },
      retries: 0,
    };
  }

  it('runs a fresh conversation and returns done with the final text as summary', async () => {
    const client = scriptedClient([finalTurn('Handoff: created the repo.')]);
    const plan = samplePlan();
    const result = await runStep({
      client,
      modelId: 'm',
      tools: fakeTools(['a.mjs']),
      systemPrompt: 'sys',
      goal: 'g',
      plan,
      step: plan.steps[2],
    });
    assert.equal(result.status, 'done');
    assert.equal(result.stoppedReason, 'complete');
    assert.equal(result.summary, 'Handoff: created the repo.');
    assert.deepEqual(result.usage, { prompt: 7, completion: 3, cost: 0 });
    assert.equal(result.retries, 1);
    // The step's conversation is fresh: its own system prompt, plus the
    // files the shared registry reported.
    const sent = client.calls[0].messages;
    assert.equal(sent[0].role, 'system');
    assert.match(sent[1].content, /- a\.mjs/);
  });

  it('truncates the summary to the cap', async () => {
    const client = scriptedClient([finalTurn('x'.repeat(5_000))]);
    const plan = samplePlan();
    const result = await runStep({
      client,
      modelId: 'm',
      tools: fakeTools(),
      systemPrompt: 'sys',
      goal: 'g',
      plan,
      step: plan.steps[2],
      summaryCap: 100,
    });
    assert.equal(result.summary.length, 100);
  });

  it('marks a step failed with a synthesized summary when it hits the turn limit', async () => {
    const client = scriptedClient([toolTurn()]);
    const plan = samplePlan();
    const result = await runStep({
      client,
      modelId: 'm',
      tools: fakeTools(),
      systemPrompt: 'sys',
      goal: 'g',
      plan,
      step: plan.steps[2],
      maxToolTurns: 2,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.stoppedReason, 'tool-limit');
    assert.equal(
      result.summary,
      'step stopped (tool-limit) after 2 tool turns',
    );
    assert.equal(result.toolTurns, 2);
  });

  it('propagates a thrown loop error like the single-loop path', async () => {
    const client = scriptedClient([new Error('provider down')]);
    const plan = samplePlan();
    await assert.rejects(
      runStep({
        client,
        modelId: 'm',
        tools: fakeTools(),
        systemPrompt: 'sys',
        goal: 'g',
        plan,
        step: plan.steps[2],
      }),
      /provider down/,
    );
  });
});

function resolverSuite(name, envKey, fn, expectations) {
  describe(name, () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = process.env[envKey];
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalEnv;
      }
    });

    it('prefers an explicit option', () => {
      process.env[envKey] = String(expectations.env);
      assert.equal(fn(expectations.option), expectations.option);
    });

    it(`falls back to ${envKey}`, () => {
      process.env[envKey] = String(expectations.env);
      assert.equal(fn(undefined), expectations.env);
    });

    it('falls back to the default when neither is set', () => {
      delete process.env[envKey];
      assert.equal(fn(undefined), expectations.fallback);
    });
  });
}

describe('planEnabled', () => {
  const envKey = 'KODR_PLAN';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('is on with an explicit option', () => {
    delete process.env[envKey];
    assert.equal(planEnabled(true), true);
  });

  it('is on with KODR_PLAN=1 or KODR_PLAN=true', () => {
    process.env[envKey] = '1';
    assert.equal(planEnabled(false), true);
    process.env[envKey] = 'true';
    assert.equal(planEnabled(false), true);
  });

  it('is off by default', () => {
    delete process.env[envKey];
    assert.equal(planEnabled(false), false);
    process.env[envKey] = '0';
    assert.equal(planEnabled(false), false);
  });
});

describe('planModelSpec', () => {
  const envKey = 'KODR_PLAN_MODEL';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
    delete process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('is unset when neither option nor env is given', () => {
    assert.deepEqual(planModelSpec(undefined), { provider: null, model: null });
  });

  it('treats a bare model id as a model on the current provider', () => {
    assert.deepEqual(planModelSpec('qwen3-235b'), {
      provider: null,
      model: 'qwen3-235b',
    });
  });

  it('keeps a slash-bearing model id whose first segment is not a provider', () => {
    assert.deepEqual(planModelSpec('google/gemma-4-26b'), {
      provider: null,
      model: 'google/gemma-4-26b',
    });
  });

  it('splits a provider-prefixed spec, preserving slashes in the model id', () => {
    assert.deepEqual(planModelSpec('openrouter/anthropic/claude-opus-4.8'), {
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4.8',
    });
    assert.deepEqual(planModelSpec('lmstudio/google/gemma-4-26b'), {
      provider: 'lmstudio',
      model: 'google/gemma-4-26b',
    });
  });

  it('falls back to KODR_PLAN_MODEL, with the option winning', () => {
    process.env[envKey] = 'ollama/big-model';
    assert.deepEqual(planModelSpec(undefined), {
      provider: 'ollama',
      model: 'big-model',
    });
    assert.deepEqual(planModelSpec('small-model'), {
      provider: null,
      model: 'small-model',
    });
  });
});

resolverSuite('planMaxSteps', 'KODR_PLAN_MAX_STEPS', planMaxSteps, {
  option: 4,
  env: 6,
  fallback: DEFAULT_PLAN_MAX_STEPS,
});

resolverSuite('planTimeoutMs', 'KODR_PLAN_TIMEOUT_MS', planTimeoutMs, {
  option: 30_000,
  env: 45_000,
  fallback: DEFAULT_PLAN_TIMEOUT_MS,
});

resolverSuite('stepMinMs', 'KODR_PLAN_STEP_MIN_MS', stepMinMs, {
  option: 10_000,
  env: 20_000,
  fallback: DEFAULT_STEP_MIN_MS,
});

resolverSuite('stepSummaryCap', 'KODR_PLAN_SUMMARY_CAP', stepSummaryCap, {
  option: 500,
  env: 900,
  fallback: DEFAULT_STEP_SUMMARY_CAP,
});

describe('stepMaxToolTurns', () => {
  const envKey = 'KODR_PLAN_STEP_MAX_TOOL_TURNS';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('prefers an explicit option', () => {
    process.env[envKey] = '9';
    assert.equal(stepMaxToolTurns(7, 20), 7);
  });

  it('falls back to KODR_PLAN_STEP_MAX_TOOL_TURNS', () => {
    process.env[envKey] = '9';
    assert.equal(stepMaxToolTurns(undefined, 20), 9);
  });

  it("falls back to the run's own maxToolTurns", () => {
    delete process.env[envKey];
    assert.equal(stepMaxToolTurns(undefined, 20), 20);
  });
});
