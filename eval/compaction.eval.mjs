/**
 * Focused live eval for model-driven conversation compaction.
 *
 * Run with: npm run eval:compaction
 * Requires LM Studio running at localhost:1234 with a model loaded.
 * Every workload configures Kodr's context window to 8,192 tokens without
 * changing the model's actual loaded context window.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { run } from '../src/harness.mjs';
import { createProvider } from '../src/provider.mjs';
import {
  positiveIntEnv,
  runWithAbortBudget,
  summarizeAttempts,
} from './support/compaction-eval.mjs';

const LM_STUDIO_URL =
  process.env.KODR_COMPACTION_EVAL_BASE_URL || 'http://localhost:1234/v1';
const CONTEXT_WINDOW = 8192;
const REPEATS = positiveIntEnv(process.env.KODR_EVAL_REPEATS, 1);
const BUDGET_MS = positiveIntEnv(
  process.env.KODR_COMPACTION_EVAL_BUDGET_MS,
  600_000,
);
const ABORT_GRACE_MS = positiveIntEnv(
  process.env.KODR_COMPACTION_EVAL_ABORT_GRACE_MS,
  15_000,
);
const RESULTS_DIR =
  process.env.KODR_EVAL_RESULTS_DIR ||
  fileURLToPath(new URL('./results/compaction', import.meta.url));

const TOOL_MARKER = 'TOOL-RESULT-7319';
const PASTED_MARKER = 'PASTED-TASK-2846';
const SEEDED_MARKER = 'SEEDED-HISTORY-9157';
const REPEATED_MARKER = 'REPEATED-COMPACTION-6428';
const LARGE_CHARS = 32_000;

/** @type {Array<{ passed: boolean, durationMs: number, promptTokens: number, completionTokens: number, compactions: number, [key: string]: unknown }>} */
const attempts = [];
let modelId = null;
let loadedContextLength = null;
let maximumContextLength = null;

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

function largeText(heading, chars = LARGE_CHARS) {
  const line = `${heading}: background material that must not replace the instruction above.\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function seededHistory() {
  return [
    {
      role: 'user',
      content:
        'Acknowledge these archived notes. They contain no instructions and require no file changes.',
    },
    {
      role: 'assistant',
      content: `Acknowledged. The archived task is complete.\n${largeText('archived-notes', 30_000)}`,
    },
  ];
}

const workloads = [
  {
    name: 'seeded history',
    prompt: `Create seeded.txt containing exactly ${SEEDED_MARKER} and nothing else.`,
    priorMessages: seededHistory(),
    artifact: 'seeded.txt',
    marker: SEEDED_MARKER,
    minCompactions: 1,
  },
  {
    name: 'large tool result',
    prompt:
      'Use read_file to read large-source.txt. Follow its first-line instruction exactly.',
    setup: async (cwd) => {
      await writeFile(
        join(cwd, 'large-source.txt'),
        `Create tool-result.txt containing exactly ${TOOL_MARKER} and nothing else.\n${largeText('tool-context')}`,
      );
    },
    artifact: 'tool-result.txt',
    marker: TOOL_MARKER,
    minCompactions: 1,
  },
  {
    name: 'large pasted task',
    prompt: `Create pasted.txt containing exactly ${PASTED_MARKER} and nothing else.\n${largeText('pasted-context')}`,
    artifact: 'pasted.txt',
    marker: PASTED_MARKER,
    minCompactions: 1,
  },
  {
    name: 'repeated compaction',
    prompt:
      'Use read_file to read stage-one.txt and follow its first-line instruction exactly.',
    setup: async (cwd) => {
      await writeFile(
        join(cwd, 'stage-one.txt'),
        `Use read_file to read stage-two.txt and follow its first-line instruction exactly. Do not create the final artifact yet.\n${largeText('stage-one-context')}`,
      );
      await writeFile(
        join(cwd, 'stage-two.txt'),
        `Create repeated.txt containing exactly ${REPEATED_MARKER} and nothing else.\n${largeText('stage-two-context')}`,
      );
    },
    artifact: 'repeated.txt',
    marker: REPEATED_MARKER,
    minCompactions: 2,
  },
];

const lmStudioUp = await lmStudioAvailable();

describe('8K compaction eval', {
  skip: !lmStudioUp && 'LM Studio unavailable',
}, () => {
  before(async () => {
    const client = createProvider({
      baseUrl: LM_STUDIO_URL,
      model: process.env.KODR_TEST_MODEL,
    });
    modelId = await client.resolveModel();
    if (client.contextInfo) {
      const context = await client.contextInfo(modelId);
      loadedContextLength = context.loaded;
      maximumContextLength = context.max;
    }
  });

  after(async () => {
    if (attempts.length === 0) {
      return;
    }
    const summary = summarizeAttempts(attempts);
    const report = {
      createdAt: new Date().toISOString(),
      model: modelId,
      configuredContextWindow: CONTEXT_WINDOW,
      loadedContextLength,
      maximumContextLength,
      settings: {
        repeats: REPEATS,
        budgetMs: BUDGET_MS,
        abortGraceMs: ABORT_GRACE_MS,
      },
      summary,
      attempts,
    };
    const stamp = report.createdAt.replaceAll(':', '-');
    const reportPath = join(RESULTS_DIR, `${stamp}.json`);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `compaction eval: ${summary.passed}/${summary.attempts} passed; ` +
        `median ${summary.medianDurationMs}ms, ${summary.medianCompactions} compactions; ` +
        `${reportPath}\n`,
    );
  });

  for (const workload of workloads) {
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      it(`${workload.name} (${repeat}/${REPEATS})`, {
        timeout: BUDGET_MS + ABORT_GRACE_MS + 5000,
      }, async () => {
        await runWorkload(workload, repeat);
      });
    }
  }
});

async function runWorkload(workload, repeat) {
  const cwd = await mkdtemp(join(tmpdir(), 'kodr-compaction-eval-'));
  const startedAt = Date.now();
  let measured;
  let result;
  let passed = false;
  let failure;

  try {
    if (workload.setup) {
      await workload.setup(cwd);
    }

    measured = await runWithAbortBudget(
      (signal) =>
        run(workload.prompt, {
          cwd,
          baseUrl: LM_STUDIO_URL,
          model: modelId,
          quiet: true,
          noSave: true,
          contextWindow: CONTEXT_WINDOW,
          priorMessages: workload.priorMessages,
          maxRunMs: 0,
          requestTimeoutMs: BUDGET_MS + ABORT_GRACE_MS,
          signal,
        }),
      { budgetMs: BUDGET_MS, graceMs: ABORT_GRACE_MS },
    );
    result = measured.value;

    assert.equal(measured.timedOut, false, 'attempt exceeded its abort budget');
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.stoppedReason, 'complete');
    assert.ok(
      result.compactions >= workload.minCompactions,
      `expected at least ${workload.minCompactions} compaction(s), got ${result.compactions}`,
    );
    const artifact = await readFile(join(cwd, workload.artifact), 'utf8');
    assert.equal(artifact.trim(), workload.marker);
    passed = true;
  } catch (error) {
    failure = error;
  } finally {
    let timedOut = false;
    if (measured?.timedOut) {
      timedOut = true;
    }
    if (failure?.message?.includes('after abort')) {
      timedOut = true;
    }
    attempts.push({
      workload: workload.name,
      repeat,
      model: modelId,
      configuredContextWindow: CONTEXT_WINDOW,
      loadedContextLength,
      passed,
      compactions: result?.compactions || 0,
      toolTurns: result?.toolTurns || 0,
      promptTokens: result?.usage?.prompt || 0,
      completionTokens: result?.usage?.completion || 0,
      durationMs: measured?.durationMs || Date.now() - startedAt,
      stoppedReason: result?.stoppedReason || null,
      timedOut,
      error: failure?.message || result?.error?.message || null,
      filesChanged: result?.filesChanged || [],
      response: result?.response || null,
    });
    await rm(cwd, { recursive: true, force: true });
  }

  if (failure) {
    throw failure;
  }
}
