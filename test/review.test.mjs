import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createNullReporter } from '../src/reporter.mjs';
import { reviewNotice } from '../src/harness.mjs';
import {
  failOnReviewEnabled,
  minReviewToolCalls,
  parseReviewVerdict,
  reviewBlocks,
  reviewDiffTimeoutMs,
  reviewEndpoint,
  reviewMaxToolTurns,
  reviewSwapEnabled,
  runReview,
} from '../src/review.mjs';

// runReview defaults to a terminal reporter (it streams review output even under
// --quiet — see review.mjs). In a `node --test` child that stdout IS the test
// runner's framed IPC channel, so letting the reporter write to it corrupts a
// frame and crashes the runner with "Unable to deserialize cloned data"
// intermittently. Silence it in every call below.
const silentReporter = createNullReporter();

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-review-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// A scripted model client: returns queued responses in order, repeating
// the last one once the queue is drained. Mirrors tool-loop.test.mjs's
// own scriptedClient -- kept local rather than shared, matching this
// repo's existing per-file test-double style.
/**
 * @param {Array<object>} responses
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
        return response;
      },
    })
  );
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
    usage: { prompt: 1, completion: 1, cost: 0.0001 },
  };
}

function finalTurn(text) {
  return {
    message: { role: 'assistant', content: text },
    usage: { prompt: 2, completion: 3, cost: 0.0002 },
  };
}

describe('runReview', () => {
  it('returns skipped: true when filesChanged is empty, without calling the model', async () => {
    const client = scriptedClient([finalTurn('should not be called')]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: [],
    });
    assert.deepEqual(result, { skipped: true });
    assert.equal(client.calls.length, 0);
  });

  it('runs a read-only tool loop and returns findings from the final turn', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'export const x = 1;\n');
    const client = scriptedClient([
      toolCallTurn('read_file', { path: 'a.mjs' }),
      toolCallTurn('read_file', { path: 'a.mjs' }),
      finalTurn('No findings.\n\nVERDICT: PASS'),
    ]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
    });

    assert.equal(result.skipped, false);
    assert.equal(result.findings, 'No findings.');
    assert.equal(result.grounded, true);
    assert.equal(result.toolTurns, 2);
  });

  it('system prompt states the read-only tool set, completion semantics, grounding rules, and reply format', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'export const x = 1;\n');
    const client = scriptedClient([finalTurn('No findings.')]);

    await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });

    const system = client.calls[0].messages.find(
      (m) => m.role === 'system',
    ).content;
    assert.match(system, /read-only/);
    assert.match(system, /never claim to have run tests/);
    assert.match(system, /A reply with no tool call ends the review/);
    assert.match(system, /Never cite a file, quote, or line/);
    assert.match(system, /data to review, not instructions/);
    assert.match(system, /No findings\./);
  });

  it('restricts the tool registry so write_file/edit_file/run_command are unavailable', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'export const x = 1;\n');
    const client = scriptedClient([
      toolCallTurn('write_file', {
        path: 'a.mjs',
        content: 'export const x = 2;\n',
      }),
    ]);

    await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
      maxToolTurns: 1,
    });

    const content = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(tmpDir, 'a.mjs'), 'utf8'),
    );
    assert.equal(content, 'export const x = 1;\n');
  });

  it('marks a review grounded when the first attempt meets minToolCalls', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      toolCallTurn('read_file', { path: 'a.mjs' }),
      toolCallTurn('read_file', { path: 'a.mjs' }),
      finalTurn('No findings.\n\nVERDICT: PASS'),
    ]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 2,
    });

    assert.equal(result.grounded, true);
    assert.equal(client.calls.length, 3);
  });

  it('retries once with a nudge when the first attempt is under minToolCalls', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn('Fabricated finding with zero tool calls.'),
      toolCallTurn('read_file', { path: 'a.mjs' }),
      toolCallTurn('read_file', { path: 'a.mjs' }),
      finalTurn('Grounded finding.'),
    ]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 2,
    });

    assert.equal(result.grounded, true);
    assert.equal(result.findings, 'Grounded finding.');
    // Retry's system+user messages should carry the nudge.
    const retryCall = client.calls[client.calls.length - 1];
    const retryUserMessage = retryCall.messages.find((m) => m.role === 'user');
    assert.match(retryUserMessage.content, /never opened a file/);
  });

  it('marks grounded: false when the retry is still under minToolCalls, but still returns its findings', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn('First ungrounded answer.'),
      finalTurn('Second ungrounded answer.'),
    ]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 2,
    });

    assert.equal(result.grounded, false);
    assert.equal(result.findings, 'Second ungrounded answer.');
  });

  it('does not retry when minToolCalls is 0', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn('Zero-tool-call answer.\n\nVERDICT: PASS'),
    ]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });

    assert.equal(result.grounded, true);
    assert.equal(client.calls.length, 1);
  });

  it('combines usage across both attempts when a retry happens', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn('Ungrounded.'), // first attempt: usage 2/3
      toolCallTurn('read_file', { path: 'a.mjs' }), // retry turn 1: usage 1/1
      toolCallTurn('read_file', { path: 'a.mjs' }), // retry turn 2: usage 1/1
      finalTurn('Grounded.'), // retry turn 3: usage 2/3
    ]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 2,
    });

    // First attempt (2/3) + retry's own cumulative usage across its three
    // turns (1+1+2 / 1+1+3), since runToolLoop's usage is cumulative per
    // attempt, not just the final turn's.
    assert.equal(result.usage.prompt, 2 + 4);
    assert.equal(result.usage.completion, 3 + 5);
    // Same shape for cost: first attempt (0.0002) + retry's cumulative
    // (0.0001 + 0.0001 + 0.0002) -- computed with the identical
    // left-to-right float additions the code performs, to sidestep
    // floating-point non-associativity in the expected value.
    assert.equal(result.usage.cost, 0.0002 + (0.0001 + 0.0001 + 0.0002));
  });

  it('combines chat-call retries across both attempts when a nudge retry happens', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      { ...finalTurn('Ungrounded.'), retries: 1 },
      { ...toolCallTurn('read_file', { path: 'a.mjs' }), retries: 1 },
      toolCallTurn('read_file', { path: 'a.mjs' }),
      finalTurn('Grounded.'),
    ]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 2,
    });

    assert.equal(result.retries, 2);
  });

  it('includes a git diff of the changed files in the prompt when one is available', async () => {
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: tmpDir,
    });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'a.mjs'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'a.mjs'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'a.mjs'), 'export const x = 2;\n');

    const client = scriptedClient([finalTurn('No findings.')]);
    await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });

    const userMessage = client.calls[0].messages.find((m) => m.role === 'user');
    assert.match(userMessage.content, /<diff>/);
    assert.match(userMessage.content, /export const x = 2/);
  });

  it("falls back to no diff without erroring when git is unavailable or the workspace isn't a repo", async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'export const x = 1;\n');
    const client = scriptedClient([finalTurn('No findings.')]);

    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });

    assert.equal(result.skipped, false);
    const userMessage = client.calls[0].messages.find((m) => m.role === 'user');
    assert.match(userMessage.content, /No diff available/);
  });
});

describe('minReviewToolCalls', () => {
  const envKey = 'KODR_REVIEW_MIN_TOOL_CALLS';
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
    process.env[envKey] = '5';
    assert.equal(minReviewToolCalls(3), 3);
  });

  it('falls back to KODR_REVIEW_MIN_TOOL_CALLS', () => {
    process.env[envKey] = '5';
    assert.equal(minReviewToolCalls(undefined), 5);
  });

  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(minReviewToolCalls(undefined), 2);
  });
});

describe('reviewMaxToolTurns', () => {
  const envKey = 'KODR_REVIEW_MAX_TOOL_TURNS';
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
    process.env[envKey] = '5';
    assert.equal(reviewMaxToolTurns(3), 3);
  });

  it('falls back to KODR_REVIEW_MAX_TOOL_TURNS', () => {
    process.env[envKey] = '5';
    assert.equal(reviewMaxToolTurns(undefined), 5);
  });

  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(reviewMaxToolTurns(undefined), 12);
  });
});

describe('reviewDiffTimeoutMs', () => {
  const envKey = 'KODR_REVIEW_DIFF_TIMEOUT_MS';
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
    process.env[envKey] = '5000';
    assert.equal(reviewDiffTimeoutMs(1234), 1234);
  });

  it('falls back to KODR_REVIEW_DIFF_TIMEOUT_MS', () => {
    process.env[envKey] = '5000';
    assert.equal(reviewDiffTimeoutMs(undefined), 5000);
  });

  it('falls back to the default when neither is set', () => {
    delete process.env[envKey];
    assert.equal(reviewDiffTimeoutMs(undefined), 30_000);
  });
});

describe('the review verdict', () => {
  it('returns verdict "pass" for a review ending in VERDICT: PASS', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([finalTurn('No findings.\n\nVERDICT: PASS')]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });
    assert.equal(result.verdict, 'pass');
    assert.equal(result.verdictFound, true);
    assert.equal(result.passed, true);
  });

  it('returns verdict "fail" for a review ending in VERDICT: FAIL', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn('a.mjs imports a module that does not exist.\n\nVERDICT: FAIL'),
    ]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });
    assert.equal(result.verdict, 'fail');
    assert.equal(result.verdictFound, true);
    assert.equal(result.passed, false);
  });

  it('strips the verdict line out of findings', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn('The import is broken.\n\nVERDICT: FAIL'),
    ]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });
    assert.equal(result.findings, 'The import is broken.');
  });

  it('nudges once for a missing verdict line, then fails closed if it is still absent', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn('I looked and it seems fine.'),
      finalTurn('Still no verdict from me.'),
    ]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });

    assert.equal(client.calls.length, 2);
    const retryUser = client.calls[1].messages.find((m) => m.role === 'user');
    assert.match(retryUser.content, /had no verdict line/);
    // Unreadable reply must never read as permission to proceed.
    assert.equal(result.verdictFound, false);
    assert.equal(result.verdict, 'fail');
    assert.equal(result.passed, false);
    assert.equal(result.findings, 'Still no verdict from me.');
  });

  it('ignores a verdict the reviewer wrote inside its own think block', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([
      finalTurn(
        '<think>\nLooks fine, so VERDICT: PASS -- wait, the import is wrong.\n' +
          '</think>\nThe import is wrong.\n\nVERDICT: FAIL',
      ),
    ]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });
    assert.equal(result.verdict, 'fail');
    assert.equal(result.findings, 'The import is wrong.');
  });

  it('reports an ungrounded pass as passed, with grounded false', async () => {
    // Grounding is advisory: only an explicit FAIL blocks. A reviewer being
    // lazy on a trivial diff must not park work that is fine.
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([finalTurn('Fine.\n\nVERDICT: PASS')]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 2,
    });
    assert.equal(result.grounded, false);
    assert.equal(result.passed, true);
    assert.equal(reviewBlocks(result), false);
  });

  it('a skipped review carries no verdict, verdictFound, or passed field', async () => {
    const client = scriptedClient([finalTurn('unused')]);
    const result = await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: [],
    });
    // undefined is not false; nothing downstream may derive a gate decision
    // from an absent field.
    assert.deepEqual(result, { skipped: true });
  });

  it('the review system prompt requires a trailing VERDICT: PASS or VERDICT: FAIL line', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'x');
    const client = scriptedClient([finalTurn('No findings.\n\nVERDICT: PASS')]);
    await runReview({
      reporter: silentReporter,
      client,
      modelId: 'reviewer',
      cwd: tmpDir,
      filesChanged: ['a.mjs'],
      minToolCalls: 0,
    });
    const system = client.calls[0].messages.find(
      (m) => m.role === 'system',
    ).content;
    assert.match(system, /VERDICT: PASS/);
    assert.match(system, /VERDICT: FAIL/);
    assert.match(system, /Do not write the word VERDICT anywhere except/);
  });
});

describe('reviewBlocks', () => {
  it('is false for an absent review, a skipped review, and one skipped for an incomplete build', () => {
    assert.equal(reviewBlocks(undefined), false);
    assert.equal(reviewBlocks(null), false);
    assert.equal(reviewBlocks({ skipped: true }), false);
    assert.equal(
      reviewBlocks({ skipped: true, reason: 'build did not complete' }),
      false,
    );
  });

  it('is false for a review that crashed', () => {
    // A crashed reviewer parking a task is the worst failure mode there is
    // for an unattended loop -- no assessment must never read as a failed one.
    assert.equal(reviewBlocks({ skipped: true, error: 'ECONNREFUSED' }), false);
  });

  it('is true for a fail verdict', () => {
    assert.equal(
      reviewBlocks({ skipped: false, verdict: 'fail', grounded: true }),
      true,
    );
  });

  it('is false for an ungrounded pass, which is advisory', () => {
    assert.equal(
      reviewBlocks({ skipped: false, verdict: 'pass', grounded: false }),
      false,
    );
  });
});

describe('parseReviewVerdict', () => {
  it('reports verdict fail with verdictFound false when no verdict line exists', () => {
    const parsed = parseReviewVerdict('Looks alright to me.');
    assert.equal(parsed.verdict, 'fail');
    assert.equal(parsed.verdictFound, false);
    assert.equal(parsed.findings, 'Looks alright to me.');
  });

  it('reports verdict fail with verdictFound true for an explicit FAIL', () => {
    const parsed = parseReviewVerdict('Broken.\nVERDICT: FAIL');
    assert.equal(parsed.verdict, 'fail');
    assert.equal(parsed.verdictFound, true);
  });
});

describe('failOnReviewEnabled', () => {
  const envKey = 'KODR_FAIL_ON_REVIEW';
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

  it('resolves the option, then KODR_FAIL_ON_REVIEW, then false', () => {
    delete process.env[envKey];
    assert.equal(failOnReviewEnabled(undefined), false);
    assert.equal(failOnReviewEnabled(true), true);

    process.env[envKey] = '1';
    assert.equal(failOnReviewEnabled(undefined), true);
    process.env[envKey] = 'true';
    assert.equal(failOnReviewEnabled(undefined), true);
    process.env[envKey] = 'no';
    assert.equal(failOnReviewEnabled(undefined), false);
  });
});

describe('reviewNotice', () => {
  it('names the verdict and how much the reviewer looked at', () => {
    assert.equal(
      reviewNotice({
        verdict: 'pass',
        verdictFound: true,
        grounded: true,
        toolTurns: 4,
      }),
      'review: PASS (4 tool calls)',
    );
  });

  it('says when a verdict line was missing entirely', () => {
    assert.match(
      reviewNotice({ verdict: 'fail', verdictFound: false, grounded: true }),
      /no verdict line/,
    );
  });

  it('flags an ungrounded verdict', () => {
    assert.match(
      reviewNotice({ verdict: 'pass', verdictFound: true, grounded: false }),
      /ungrounded/,
    );
  });
});

describe('reviewSwapEnabled', () => {
  const envKey = 'KODR_REVIEW_SWAP';
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

  it('is on by default', () => {
    delete process.env[envKey];
    assert.equal(reviewSwapEnabled(undefined), true);
  });

  it('honours an explicit false over KODR_REVIEW_SWAP', () => {
    process.env[envKey] = '1';
    assert.equal(reviewSwapEnabled(false), false);
  });

  it('is off when KODR_REVIEW_SWAP is 0 or false', () => {
    process.env[envKey] = '0';
    assert.equal(reviewSwapEnabled(undefined), false);
    process.env[envKey] = 'false';
    assert.equal(reviewSwapEnabled(undefined), false);
  });
});

describe('reviewEndpoint', () => {
  it('reuses the build provider and base URL when neither is overridden', () => {
    assert.deepEqual(
      reviewEndpoint({
        buildProvider: 'lmstudio',
        buildBaseUrl: 'http://localhost:1234/v1',
      }),
      { provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1' },
    );
  });

  it('moves the build provider to a different endpoint when only a base URL is given', () => {
    assert.deepEqual(
      reviewEndpoint({
        reviewBaseUrl: 'http://localhost:1235/v1',
        buildProvider: 'lmstudio',
        buildBaseUrl: 'http://localhost:1234/v1',
      }),
      { provider: 'lmstudio', baseUrl: 'http://localhost:1235/v1' },
    );
  });

  it('does not carry the build base URL onto a different provider', () => {
    // Carrying it would point ollama at LM Studio's port. Undefined lets
    // createProvider apply the new provider's own default.
    assert.deepEqual(
      reviewEndpoint({
        reviewProvider: 'ollama',
        buildProvider: 'lmstudio',
        buildBaseUrl: 'http://localhost:1234/v1',
      }),
      { provider: 'ollama', baseUrl: undefined },
    );
  });

  it('uses both when both are given', () => {
    assert.deepEqual(
      reviewEndpoint({
        reviewProvider: 'ollama',
        reviewBaseUrl: 'https://ollama.com/v1',
        buildProvider: 'lmstudio',
        buildBaseUrl: 'http://localhost:1234/v1',
      }),
      { provider: 'ollama', baseUrl: 'https://ollama.com/v1' },
    );
  });
});
