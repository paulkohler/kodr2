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

const LM_STUDIO_URL = 'http://localhost:1234/v1';

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
