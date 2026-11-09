import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildAcpOptions,
  buildRunOptions,
  main,
  parseArgs,
} from '../src/cli.mjs';
import {
  assembleResponse,
  createClient,
  isAbortError,
  maxOutputTokens,
} from '../src/model.mjs';
import { createProvider } from '../src/provider.mjs';
import { createNullReporter } from '../src/reporter.mjs';
import { processModelResponse } from '../src/tool-loop.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';

const env = new Map();
beforeEach(() => {
  for (const key of [
    'KODR_MAX_OUTPUT_TOKENS',
    'OPENROUTER_API_KEY',
    'KODR_REASONING',
  ]) {
    env.set(key, process.env[key]);
    delete process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of env) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// An already-aborted request exposes the real serialized request through the
// debug callback but is destroyed before any network traffic can be sent.
async function requestBody(client) {
  const controller = new AbortController();
  controller.abort();
  let body;
  await assert.rejects(
    client.chat({
      messages: [],
      signal: controller.signal,
      onDebug: (event) => {
        body = event.requestBody;
      },
    }),
    isAbortError,
  );
  return body;
}

describe('output token configuration', () => {
  it('resolves explicit values over env over the disabled default', () => {
    assert.equal(maxOutputTokens(), 0);
    process.env.KODR_MAX_OUTPUT_TOKENS = '4096';
    assert.equal(maxOutputTokens(), 4096);
    assert.equal(maxOutputTokens(128), 128);
    assert.equal(maxOutputTokens(0), 0);
    for (const invalid of [
      'garbage',
      '-1',
      '1.5',
      'Infinity',
      '9007199254740992',
    ]) {
      process.env.KODR_MAX_OUTPUT_TOKENS = invalid;
      assert.equal(maxOutputTokens(), 0);
    }
  });

  it('parses CLI values and carries them into run options', () => {
    for (const cap of [0, 4096]) {
      const args = parseArgs([
        'run',
        'task',
        '--max-output-tokens',
        String(cap),
      ]);
      assert.equal(args.maxOutputTokens, cap);
      assert.equal(buildRunOptions(args, '/tmp', true).maxOutputTokens, cap);
      assert.equal(buildAcpOptions(args).maxOutputTokens, cap);
    }
    assert.equal(parseArgs(['run', 'task']).maxOutputTokens, null);
  });

  for (const command of ['run', 'goal', 'loop', 'consolidate', 'acp']) {
    it(`rejects invalid limits before ${command} starts`, async (t) => {
      const notices = [];
      t.mock.method(process.stderr, 'write', (text) => {
        notices.push(text);
        return true;
      });
      const exitCode = process.exitCode;
      try {
        for (const value of [
          '-1',
          '1.5',
          'NaN',
          '9007199254740992',
          undefined,
        ]) {
          process.exitCode = undefined;
          const argv = [command, 'task', '--max-output-tokens'];
          if (value !== undefined) {
            argv.push(value);
          }
          await main(argv);
          assert.equal(process.exitCode, 1);
        }
        assert.equal(notices.length, 5);
        assert.ok(
          notices.every((text) => text.includes('--max-output-tokens')),
        );
      } finally {
        process.exitCode = exitCode;
      }
    });
  }

  it('omits max_tokens when disabled, including an explicit override of the env', async () => {
    assert.equal('max_tokens' in (await requestBody(createClient())), false);
    process.env.KODR_MAX_OUTPUT_TOKENS = '1024';
    assert.equal(
      'max_tokens' in (await requestBody(createClient({ maxOutputTokens: 0 }))),
      false,
    );
    assert.equal(
      'max_tokens' in
        (await requestBody(
          createClient({ maxOutputTokens: 0, extraBody: { max_tokens: 9000 } }),
        )),
      false,
    );
  });

  it('a positive cap wins over extraBody', async () => {
    const body = await requestBody(
      createClient({ maxOutputTokens: 256, extraBody: { max_tokens: 9000 } }),
    );
    assert.equal(body.max_tokens, 256);
  });

  for (const provider of ['lmstudio', 'ollama', 'openrouter']) {
    it(`${provider} forwards explicit and environment caps through the factory`, async () => {
      process.env.OPENROUTER_API_KEY = 'unit-test-not-sent';
      process.env.KODR_MAX_OUTPUT_TOKENS = '512';
      const options = { provider, model: 'unit-test', reasoning: false };
      assert.equal(
        (await requestBody(createProvider(options))).max_tokens,
        512,
      );
      assert.equal(
        (
          await requestBody(
            createProvider({ ...options, maxOutputTokens: 128 }),
          )
        ).max_tokens,
        128,
      );
    });
  }
});

describe('finish reason assembly', () => {
  for (const delta of [undefined, {}, { content: 'partial' }]) {
    it(`preserves length on a ${JSON.stringify(delta)} delta followed by usage`, () => {
      const response = assembleResponse([
        { choices: [{ delta, finish_reason: 'length' }] },
        { choices: [{ delta: {}, finish_reason: null }] },
        {
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.01 },
        },
      ]);
      assert.equal(response.finishReason, 'length');
      assert.deepEqual(response.usage, {
        prompt: 2,
        completion: 3,
        cost: 0.01,
      });
    });
  }
  it('preserves other finish reasons and defaults to null when absent', () => {
    assert.equal(assembleResponse([]).finishReason, null);
    assert.equal(
      assembleResponse([{ choices: [{ finish_reason: 'stop' }] }]).finishReason,
      'stop',
    );
  });
});

describe('truncated responses over real workspace tools', () => {
  let dir;
  let tools;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kodr-output-'));
    tools = createToolRegistry(dir);
    await writeFile(join(dir, 'target.txt'), 'original');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const drafts = [
    {
      id: 'valid',
      function: {
        name: 'write_file',
        arguments: '{"path":"target.txt","content":"changed"}',
      },
    },
    {
      id: 'partial',
      function: {
        name: 'write_file',
        arguments: '{"path":"target.txt","content":"cut',
      },
    },
  ];
  const variants = [
    { role: 'assistant', content: 'VERDICT: MET' },
    {
      role: 'assistant',
      content: '',
      reasoning: 'still thinking',
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }],
    },
    { role: 'assistant', content: '', tool_calls: drafts },
    {
      role: 'assistant',
      content: 'write_file[ARGS]{"path":"target.txt","content":"changed"}',
    },
  ];
  for (const message of variants) {
    it(`preserves and continues ${JSON.stringify(message)} without executing it`, async () => {
      const original = structuredClone(message);
      const messages = [];
      const result = await processModelResponse(
        { message, finishReason: 'length' },
        {
          tools,
          messages,
          reporter: createNullReporter(),
        },
      );
      assert.deepEqual(result, {
        completed: false,
        finalText: '',
        usedTools: false,
      });
      assert.deepEqual(message, original);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].tool_calls, undefined);
      assert.deepEqual(
        messages[0].reasoning_details,
        message.reasoning_details,
      );
      assert.match(messages[1].content, /No tool calls.*were executed/);
      if (message.tool_calls) {
        assert.match(messages[0].content, /Unexecuted tool-call drafts/);
      }
      assert.equal(await readFile(join(dir, 'target.txt'), 'utf8'), 'original');
      assert.deepEqual(tools.filesChanged(), []);
    });
  }

  it('assembles a truncated stream into a replay-safe continuation', async () => {
    const details = [{ type: 'reasoning.encrypted', data: 'opaque' }];
    const response = assembleResponse([
      {
        choices: [
          {
            delta: {
              content: 'Partial plan',
              reasoning: 'reasoning',
              reasoning_details: details,
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'draft',
                  function: {
                    name: 'write_file',
                    arguments: '{"path":"target.txt","content":"cut',
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: 'length' }] },
      {
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 7, cost: 0.01 },
      },
    ]);
    const messages = [];
    const result = await processModelResponse(response, {
      tools,
      messages,
      reporter: createNullReporter(),
    });
    assert.equal(result.completed, false);
    assert.equal(result.usedTools, false);
    assert.equal(messages[0].reasoning, 'reasoning');
    assert.deepEqual(messages[0].reasoning_details, details);
    assert.match(messages[0].content, /Partial plan/);
    assert.match(messages[0].content, /target.txt/);
    assert.equal(messages[0].tool_calls, undefined);
    assert.deepEqual(response.usage, { prompt: 5, completion: 7, cost: 0.01 });
    assert.equal(await readFile(join(dir, 'target.txt'), 'utf8'), 'original');
  });

  it('executes a resent complete call once and accepts the eventual final answer', async () => {
    const messages = [];
    const ctx = { tools, messages, reporter: createNullReporter() };
    await processModelResponse(
      { message: variants[2], finishReason: 'length' },
      ctx,
    );
    const executed = await processModelResponse(
      {
        message: { role: 'assistant', tool_calls: [drafts[0]] },
        finishReason: 'tool_calls',
      },
      ctx,
    );
    assert.equal(executed.usedTools, true);
    assert.equal(await readFile(join(dir, 'target.txt'), 'utf8'), 'changed');
    assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
    const final = await processModelResponse(
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
      ctx,
    );
    assert.deepEqual(final, {
      completed: true,
      finalText: 'done',
      usedTools: false,
    });
  });
});
