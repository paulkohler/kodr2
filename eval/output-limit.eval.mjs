// Real LM Studio checks for BACKLOG #15. No model mocks or fixture server.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compactMessages } from '../src/compact.mjs';
import {
  runMemoryConsolidation,
  runMemoryRetrospective,
} from '../src/memory.mjs';
import { createProvider } from '../src/provider.mjs';
import { runToolLoop } from '../src/tool-loop.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';

const requestTimeout =
  Number(process.env.KODR_OUTPUT_EVAL_TIMEOUT_MS) || 120_000;
const baseUrl =
  process.env.KODR_OUTPUT_EVAL_BASE_URL || 'http://localhost:1234/v1';
const model = process.env.KODR_TEST_MODEL || 'qwen/qwen3-coder-30b';
let dir;
let client;
const messages = [
  { role: 'system', content: 'Follow the user request. Do not use tools.' },
  {
    role: 'user',
    content:
      'Write the numbers from one to one hundred, each spelled out, one per line.',
  },
];

describe('output limits against real LM Studio', {
  timeout: requestTimeout * 3,
}, () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kodr-output-eval-'));
    client = createProvider({
      provider: 'lmstudio',
      baseUrl,
      model,
      maxOutputTokens: 1,
      timeout: requestTimeout,
    });
    await writeFile(
      join(dir, 'MEMORY.md'),
      '- Always verify changes with tests.\n- Verify changes with tests.\n',
    );
  });
  after(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('receives a length finish reason with usage instead of timing out', async () => {
    const result = await client.chat({ messages });
    assert.equal(result.finishReason, 'length');
    assert.ok(result.usage.prompt > 0);
    assert.ok(result.usage.completion >= 0);
  });

  it('bounds repeated truncation without counting it as grounded tool use', async () => {
    const history = structuredClone(messages);
    let requests = 0;
    const result = await runToolLoop({
      client,
      modelId: model,
      messages: history,
      tools: createToolRegistry(dir, { allowedTools: [] }),
      maxToolTurns: 2,
      startedAt: new Date(),
      maxRunMs: requestTimeout * 2,
      onDebug: (event) => {
        requests += 1;
        assert.equal(event.requestBody.max_tokens, 1);
      },
    });
    assert.equal(result.stoppedReason, 'tool-limit');
    assert.equal(result.completed, false);
    assert.equal(result.finalText, '');
    assert.equal(result.toolTurns, 0);
    assert.equal(requests, 2);
    assert.equal(history.filter((m) => m.role === 'assistant').length, 2);
    assert.ok(result.usage.prompt > 0);
  });

  it('the CLI carries the cap and reports an incomplete run', async () => {
    let output;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('../bin/kodr.mjs', import.meta.url)),
          'run',
          messages[1].content,
          '--cwd',
          dir,
          '--model',
          model,
          '--base-url',
          baseUrl,
          '--max-output-tokens',
          '1',
          '--max-tool-turns',
          '2',
          '--context-window',
          '0',
          '--max-run-ms',
          String(requestTimeout * 2),
          '--request-timeout-ms',
          String(requestTimeout),
          '--quiet',
          '--json',
          '--no-save',
        ],
        { timeout: requestTimeout * 3 },
      );
      assert.fail('a truncated run must exit non-zero');
    } catch (error) {
      assert.equal(error.code, 1, error.stderr);
      output = JSON.parse(error.stdout);
    }
    assert.equal(output.stoppedReason, 'tool-limit');
    assert.equal(output.completed, false);
    assert.equal(output.toolTurns, 0);
    assert.deepEqual(output.filesChanged, []);
  });

  it('keeps the full conversation when the compaction summary is truncated', async () => {
    const history = structuredClone(messages);
    const result = await compactMessages({
      client,
      modelId: model,
      messages: history,
    });
    assert.match(result.error, /token limit/);
    assert.deepEqual(result.messages, messages);
    assert.deepEqual(history, messages);
    assert.ok(result.usage.prompt > 0);
  });

  it('does not apply or propose truncated memory output', async () => {
    const file = join(dir, 'MEMORY.md');
    const before = await readFile(file, 'utf8');
    const runsDir = join(dir, 'runs');
    const retrospective = await runMemoryRetrospective({
      client,
      modelId: model,
      cwd: dir,
      runsDir,
      messages: structuredClone(messages),
      startedAt: new Date(),
      toolTurns: 1,
      autoApply: true,
    });
    const consolidation = await runMemoryConsolidation({
      client,
      modelId: model,
      cwd: dir,
      runsDir,
      apply: true,
    });
    for (const result of [retrospective, consolidation]) {
      assert.equal(result.proposed, false);
      assert.match(result.error, /token limit/);
      assert.ok(result.usage.prompt > 0);
    }
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(await readdir(dir), ['MEMORY.md']);
  });
});
