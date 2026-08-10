/**
 * Integration eval — end-to-end memory retrospective against real LM Studio.
 *
 * Run with: node --test eval/memory.eval.mjs
 * Requires LM Studio running at localhost:1234 with a model loaded.
 *
 * Two sequential runs in the same workspace: the first (with
 * --memory-auto-apply, so it doesn't block on a y/N prompt) should
 * propose and apply a lesson to MEMORY.md; the second should load that
 * lesson back into its system prompt. The mechanics (proposed, applied,
 * loaded into the next run's own messages) are asserted deterministically.
 * Whether the model's free-form behavior visibly changes is inherently
 * probabilistic with a local model -- logged, not hard-asserted, matching
 * this repo's existing eval philosophy (track pass rates, not binary
 * pass/fail).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { run } from '../src/harness.mjs';
import { readMemory, runMemoryConsolidation } from '../src/memory.mjs';
import { createProvider } from '../src/provider.mjs';

const LM_STUDIO_URL = 'http://localhost:1234/v1';
const MODEL = process.env.KODR_TEST_MODEL || 'qwen/qwen3-coder-30b';

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

describe('memory retrospective eval', {
  skip: !(await lmStudioAvailable()) && 'LM Studio not available',
}, () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kodr-memory-eval-'));
  });

  after(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("second run's system prompt includes a lesson applied from the first", {
    timeout: 180_000,
  }, async () => {
    // A discoverable gotcha the model has to notice and adapt to --
    // gives the retrospective something concrete to write about.
    await writeFile(
      join(tmpDir, 'CONSTRAINTS.md'),
      'All new .mjs files in this project must start with a\n' +
        '`// LICENSE: internal-only` comment as their very first line.\n' +
        'This is enforced by a check not present in this sandbox --\n' +
        'just a convention new contributors miss on their first PR.\n',
    );

    // noSave is deliberately NOT set here: the memory retrospective is
    // gated behind !noSave (same as incident telemetry), since a
    // clean-workspace/benchmark run has no future run in this
    // workspace to benefit from a lesson anyway.
    const result1 = await run(
      'Read CONSTRAINTS.md, then create a file named greet.mjs that exports a function greet(name) returning a greeting string, following every constraint described in CONSTRAINTS.md.',
      {
        cwd: tmpDir,
        baseUrl: LM_STUDIO_URL,
        quiet: true,
        memory: true,
        memoryAutoApply: true,
      },
    );

    assert.equal(result1.stoppedReason, 'complete');
    assert.ok(result1.memory, 'expected a memory result to be attached');
    assert.equal(result1.memory.proposed, true);

    if (!result1.memory.notes) {
      console.log(
        'memory eval: first run produced no findings -- skipping the propagation check (probabilistic with a local model)',
      );
      return;
    }

    assert.equal(result1.memory.applied, true);
    const memoryContent = await readFile(join(tmpDir, 'MEMORY.md'), 'utf8');
    assert.ok(memoryContent.includes(result1.memory.notes));

    const result2 = await run('List the files in this workspace.', {
      cwd: tmpDir,
      baseUrl: LM_STUDIO_URL,
      quiet: true,
      noSave: true,
    });

    const systemMessage = result2.messages.find((m) => m.role === 'system');
    assert.ok(systemMessage.content.includes('<memory>'));
    assert.ok(systemMessage.content.includes(result1.memory.notes));
    console.log(
      "memory eval: second run's system prompt included the applied lesson:",
      result1.memory.notes,
    );
  });
});

// The consolidation fixture: two duplicate lessons, one contradiction whose
// later entry must win, session narrative to drop, and one distinct durable
// lesson that must survive verbatim enough to grep for.
const CLUTTERED_MEMORY = `## 2026-03-01T10:00:00.000Z

- Tests are run with \`npm test\`, which wraps \`node --test test/*.test.mjs\`.

## 2026-03-04T09:00:00.000Z

- The API client lives in src/api-client.mjs; retry logic is in src/retry.mjs.
- Run the test suite with \`npm test\` before committing.

## 2026-05-20T15:00:00.000Z

- In this session I spent a long time debugging the fetch mock before
  realizing the fixture server was already running on port 4000.
- Database fixtures MUST be regenerated with \`npm run fixtures\` after any
  schema change.

## 2026-06-10T08:00:00.000Z

- Correction: the API client moved to src/net/client.mjs; the old
  src/api-client.mjs path no longer exists.
`;

describe('memory consolidation eval', {
  skip: !(await lmStudioAvailable()) && 'LM Studio not available',
}, () => {
  let client;
  let modelId;

  before(async () => {
    client = createProvider({ baseUrl: LM_STUDIO_URL, model: MODEL });
    modelId = await client.resolveModel();
  });

  it('merges duplicates, keeps the surviving truth of a contradiction, strips dated headings', {
    timeout: 300_000,
  }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'kodr-consolidate-eval-'));
    try {
      await writeFile(join(tmpDir, 'MEMORY.md'), CLUTTERED_MEMORY);
      const before = await readMemory(tmpDir);

      const result = await runMemoryConsolidation({
        client,
        modelId,
        cwd: tmpDir,
        runsDir: join(tmpDir, '.kodr', 'runs'),
        apply: true,
      });

      assert.equal(result.proposed, true);
      assert.equal(result.error, undefined);
      assert.equal(result.applied, true);
      assert.ok(result.backupPath, 'expected the prior content backed up');
      assert.equal(await readFile(result.backupPath, 'utf8'), before);

      const after = await readMemory(tmpDir);
      // Hard assertions: explicit prompt contract, or a lesson that must
      // survive any faithful consolidation.
      assert.ok(
        after.includes('npm run fixtures'),
        'the distinct fixtures lesson must survive',
      );
      assert.ok(
        after.includes('src/net/client.mjs'),
        'the surviving truth of the contradiction must be kept',
      );
      assert.ok(
        !/^## 2026-/m.test(after),
        'dated headings are an artifact of appending and must go',
      );
      assert.ok(!after.includes('<think>'), 'no think text in the file');

      // Probabilistic quality -- logged, not asserted, per this repo's eval
      // philosophy (track pass rates, not binary pass/fail).
      console.log(
        `consolidation eval: ${before.length} -> ${after.length} chars;`,
        `narrative dropped: ${!after.includes('port 4000')};`,
        `stale path gone: ${!after.includes('src/api-client.mjs')}`,
      );
      console.log(`consolidation eval: consolidated file:\n${after}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves an already-tight memory file untouched unattended', {
    timeout: 300_000,
  }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'kodr-consolidate-eval-'));
    try {
      const tight = '- Run tests with `npm test` before committing.\n';
      await writeFile(join(tmpDir, 'MEMORY.md'), tight);

      // Unattended, no apply: whatever the model says, MEMORY.md must not
      // change -- that mechanic is deterministic. Whether the model answers
      // NO CHANGES for a file this tight is the probabilistic part.
      const result = await runMemoryConsolidation({
        client,
        modelId,
        cwd: tmpDir,
        runsDir: join(tmpDir, '.kodr', 'runs'),
      });

      assert.equal(result.proposed, true);
      assert.equal(await readMemory(tmpDir), tight.trim());
      console.log(
        `consolidation eval: tight file -> ${
          result.notes === ''
            ? 'no-op (sentinel or identical rewrite -- ideal)'
            : 'proposed a reworded rewrite'
        }`,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
