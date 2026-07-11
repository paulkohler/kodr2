import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createNullReporter } from '../src/reporter.mjs';
import { createCaptureReporter } from './capture-reporter.mjs';
import {
  executeNativeToolCalls,
  executeRecoveredTextToolCall,
  MAX_TOOL_TURNS,
  recoverTextToolCall,
  runToolLoop,
} from '../src/tool-loop.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';

let tmpDir;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-tool-loop-'));
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

describe('recoverTextToolCall', () => {
  it('recovers a single tool_name[ARGS] call with JSON object args', () => {
    const call = recoverTextToolCall(
      'edit_file[ARGS]{"path":"a.mjs","old_string":"x","new_string":"y"}',
    );
    assert.deepEqual(call, {
      name: 'edit_file',
      args: { path: 'a.mjs', old_string: 'x', new_string: 'y' },
    });
  });

  it('rejects non-object args', () => {
    assert.equal(recoverTextToolCall('read_file[ARGS][]'), null);
  });

  it('rejects text that is not exactly a recovered tool call', () => {
    assert.equal(recoverTextToolCall('please run edit_file[ARGS]{}'), null);
  });
});

describe('executeRecoveredTextToolCall', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('routes recovered calls through the tool registry', async () => {
    await writeFile(join(tmpDir, 'target.mjs'), 'export const value = 1;\n');
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const recovered = await executeRecoveredTextToolCall(
      {
        role: 'assistant',
        content:
          'edit_file[ARGS]{"path":"target.mjs","old_string":"value = 1","new_string":"value = 2"}',
      },
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(recovered, true);
    assert.equal(
      await readFile(join(tmpDir, 'target.mjs'), 'utf8'),
      'export const value = 2;\n',
    );
    assert.deepEqual(registry.filesChanged(), ['target.mjs']);
    assert.equal(messages[0].role, 'user');
    assert.match(
      messages[0].content,
      /Recovered text-form tool call edit_file/,
    );
  });

  it('recovers a [TOOL_CALLS]-framed write that earlier failed as unknown tool', async () => {
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    // The exact dogfood shape: an echoed prior result, the framing token, then
    // the real write_file call — previously dropped as an "unknown tool".
    const recovered = await executeRecoveredTextToolCall(
      {
        role: 'assistant',
        content:
          '{"written":true,"path":"server.js"}[TOOL_CALLS]write_file{"path":"README.md","content":"# TODO API\\n"}',
      },
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(recovered, true);
    assert.equal(
      await readFile(join(tmpDir, 'README.md'), 'utf8'),
      '# TODO API\n',
    );
    assert.deepEqual(registry.filesChanged(), ['README.md']);
  });

  it('executes every recovered call in a multi-call message', async () => {
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const recovered = await executeRecoveredTextToolCall(
      {
        role: 'assistant',
        content:
          '[TOOL_CALLS][{"name":"write_file","arguments":{"path":"a.txt","content":"a"}},{"name":"write_file","arguments":{"path":"b.txt","content":"b"}}]',
      },
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(recovered, true);
    assert.equal(messages.length, 2);
    assert.equal(await readFile(join(tmpDir, 'a.txt'), 'utf8'), 'a');
    assert.equal(await readFile(join(tmpDir, 'b.txt'), 'utf8'), 'b');
  });
});

// A scripted model client: returns queued responses in order, repeating the
// last one once the queue is drained. Records every chat() call.
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
          id: 'call_1',
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { prompt: 1, completion: 1 },
  };
}

function finalTurn(text) {
  return {
    message: { role: 'assistant', content: text },
    usage: { prompt: 2, completion: 3 },
  };
}

const stubTools = /** @type {import('../src/tools/index.mjs').ToolRegistry} */ (
  /** @type {any} */ ({
    definitions: () => [],
    dispatch: async () => ({ ok: true }),
  })
);

describe('runToolLoop', () => {
  it('injects a user image message after a view_image tool call', async () => {
    // view_image returns an image result; the loop must append a compact tool
    // ack plus a user message carrying the image content part (an image can't
    // ride in a tool message). Then the model answers.
    const client = scriptedClient([
      toolCallTurn('view_image', { path: 'pic.png' }),
      finalTurn('I see it'),
    ]);
    const tools = /** @type {import('../src/tools/index.mjs').ToolRegistry} */ (
      /** @type {any} */ ({
        definitions: () => [],
        dispatch: async () => ({
          image: {
            path: 'pic.png',
            mediaType: 'image/png',
            dataBase64: 'AAAA',
          },
        }),
      })
    );
    const messages = [];
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools,
    });

    assert.equal(loop.completed, true);
    const toolMsg = messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.content, JSON.stringify({ viewing: 'pic.png' }));
    const imageMsg = messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content),
    );
    assert.ok(imageMsg, 'expected an injected user image message');
    const imagePart = imageMsg.content.find((p) => p.type === 'image_url');
    assert.equal(imagePart.image_url.url, 'data:image/png;base64,AAAA');
  });

  it('routes tool calls, tool results, and the completing turn through the reporter', async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}),
      finalTurn('done'),
    ]);
    const { reporter, events } = createCaptureReporter();
    await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
      reporter,
    });

    const types = events.map((e) => e.type);
    assert.ok(types.includes('toolCall'), 'expected a toolCall event');
    assert.ok(types.includes('toolResult'), 'expected a toolResult event');
    const toolCall = events.find((e) => e.type === 'toolCall');
    assert.equal(/** @type {any} */ (toolCall).payload.name, 'list_files');
    const turnEnd = events.find((e) => e.type === 'turnEnd');
    assert.ok(turnEnd, 'expected a turnEnd event');
    assert.equal(/** @type {any} */ (turnEnd).payload.completed, true);
  });

  it('completes when the model answers with no tool call', async () => {
    const client = scriptedClient([finalTurn('done')]);
    const messages = [];
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
    });

    assert.equal(loop.completed, true);
    assert.equal(loop.stoppedReason, 'complete');
    assert.equal(loop.finalText, 'done');
    assert.equal(loop.toolTurns, 0);
    assert.deepEqual(loop.usage, { prompt: 2, completion: 3, cost: 0 });
  });

  it('runs a tool call then completes, accumulating usage', async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}),
      finalTurn('fixed'),
    ]);
    let dispatched = 0;
    const tools = /** @type {import('../src/tools/index.mjs').ToolRegistry} */ (
      /** @type {any} */ ({
        definitions: () => [],
        dispatch: async () => {
          dispatched++;
          return { ok: true };
        },
      })
    );
    const messages = [];
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools,
    });

    assert.equal(dispatched, 1);
    assert.equal(loop.toolTurns, 1);
    assert.equal(loop.completed, true);
    assert.equal(loop.finalText, 'fixed');
    assert.deepEqual(loop.usage, { prompt: 3, completion: 4, cost: 0 });
    assert.ok(messages.some((m) => m.role === 'tool'));
  });

  it('accumulates retries across turns', async () => {
    const client = scriptedClient([
      { ...toolCallTurn('list_files', {}), retries: 1 },
      { ...finalTurn('fixed'), retries: 2 },
    ]);
    const tools = /** @type {import('../src/tools/index.mjs').ToolRegistry} */ (
      /** @type {any} */ ({
        definitions: () => [],
        dispatch: async () => ({ ok: true }),
      })
    );
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools,
    });

    assert.equal(loop.retries, 3);
  });

  it('defaults retries to 0 when the model client never reports any', async () => {
    const client = scriptedClient([finalTurn('done')]);
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
    });

    assert.equal(loop.retries, 0);
  });

  it('stops at the tool-turn ceiling when the model never finishes', async () => {
    const client = scriptedClient([toolCallTurn('list_files', {})]);
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
    });

    assert.equal(loop.completed, false);
    assert.equal(loop.stoppedReason, 'tool-limit');
    assert.equal(loop.toolTurns, MAX_TOOL_TURNS);
    assert.equal(client.calls.length, MAX_TOOL_TURNS);
  });

  it('honors a custom maxToolTurns ceiling', async () => {
    const client = scriptedClient([toolCallTurn('list_files', {})]);
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
      maxToolTurns: 3,
    });

    assert.equal(loop.completed, false);
    assert.equal(loop.stoppedReason, 'tool-limit');
    assert.equal(loop.toolTurns, 3);
    assert.equal(client.calls.length, 3);
  });

  it('stops on the run budget before calling the model', async () => {
    const client = scriptedClient([finalTurn('x')]);
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
      startedAt: new Date(Date.now() - 1000),
      maxRunMs: 1,
    });

    assert.equal(loop.completed, false);
    assert.equal(loop.stoppedReason, 'budget-exceeded');
    assert.equal(loop.toolTurns, 0);
    assert.equal(client.calls.length, 0);
  });

  it('caps each chat call to the remaining run budget, not the full budget', async () => {
    const client = scriptedClient([finalTurn('done')]);
    const startedAt = new Date(Date.now() - 9_000);
    await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
      startedAt,
      maxRunMs: 10_000,
    });

    assert.equal(client.calls.length, 1);
    // ~1000ms left of the 10s budget, not a fresh 10s timeout.
    assert.ok(client.calls[0].timeoutMs <= 1000);
    assert.ok(client.calls[0].timeoutMs > 0);
  });

  it('passes no timeoutMs when the run has no budget', async () => {
    const client = scriptedClient([finalTurn('done')]);
    await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
    });

    assert.equal(client.calls[0].timeoutMs, undefined);
  });

  it('forwards heartbeatMs and onHeartbeat to the model client', async () => {
    const client = scriptedClient([finalTurn('done')]);
    const onHeartbeat = () => {};
    await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
      heartbeatMs: 5000,
      onHeartbeat,
    });

    assert.equal(client.calls[0].heartbeatMs, 5000);
    assert.equal(client.calls[0].onHeartbeat, onHeartbeat);
  });

  it('reports a timeout at the run deadline as budget-exceeded, not an error', async () => {
    // The chat is capped to the last of the run budget and times out because
    // that budget is spent. It must be a clean budget-exceeded stop, not a
    // thrown error. maxRunMs is small and the chat takes longer than the
    // remaining budget, so by the time it throws the budget is exceeded.
    const client =
      /** @type {import('../src/provider.mjs').Provider & { calls: Array<any> }} */ (
        /** @type {any} */ ({
          calls: [],
          async chat(params) {
            this.calls.push(params);
            await new Promise((resolve) => setTimeout(resolve, 60));
            throw Object.assign(new Error('Request timed out after 5ms'), {
              code: 'ETIMEDOUT',
            });
          },
        })
      );

    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
      startedAt: new Date(Date.now() - 15),
      maxRunMs: 20,
    });

    assert.equal(loop.completed, false);
    assert.equal(loop.stoppedReason, 'budget-exceeded');
  });

  it('still throws a timeout that is not at the run deadline (no budget)', async () => {
    // Same timeout error, but with no run budget: isRunBudgetExceeded is false,
    // so this is a genuine failure and must surface as an error, not a clean
    // budget-exceeded stop.
    const client = /** @type {import('../src/provider.mjs').Provider} */ (
      /** @type {any} */ ({
        async chat() {
          throw Object.assign(new Error('Request timed out after 30000ms'), {
            code: 'ETIMEDOUT',
          });
        },
      })
    );

    await assert.rejects(
      runToolLoop({
        client,
        modelId: 'm',
        messages: [],
        tools: stubTools,
      }),
      (/** @type {any} */ err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        return true;
      },
    );
  });

  it('carries usage/turns/retries accumulated before a mid-loop error onto the thrown error', async () => {
    // Turn 1 is a real (paid) tool turn; turn 2's chat throws. The accounting
    // from turn 1 must survive on the error so the run record does not report
    // toolTurns: 0, cost: 0 for work that actually happened.
    let call = 0;
    const client =
      /** @type {import('../src/provider.mjs').Provider & { calls: Array<any> }} */ (
        /** @type {any} */ ({
          calls: [],
          async chat() {
            call++;
            if (call === 1) {
              return {
                message: toolCallTurn('list_files', {}).message,
                usage: { prompt: 100, completion: 10, cost: 0.5 },
              };
            }
            const err = /** @type {Error & { retries: number }} */ (
              new Error('model offline mid-loop')
            );
            err.retries = 2;
            throw err;
          },
        })
      );

    await assert.rejects(
      runToolLoop({
        client,
        modelId: 'm',
        messages: [],
        tools: stubTools,
      }),
      (/** @type {any} */ err) => {
        assert.equal(err.message, 'model offline mid-loop');
        assert.equal(err.toolTurns, 1);
        assert.deepEqual(err.usage, { prompt: 100, completion: 10, cost: 0.5 });
        assert.equal(err.compactions, 0);
        // The failing call's own retries (2) add to the accumulated total (0).
        assert.equal(err.retries, 2);
        return true;
      },
    );
  });
});

// Tool calls come straight from the model and are untrusted: argument JSON may
// be malformed, names may be invented, and a single message may carry several
// calls. executeNativeToolCalls must dispatch each one without throwing and
// always feed back a parseable tool result.
function nativeToolMessage(calls) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls.map((call, i) => ({
      id: call.id ?? `call_${i}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

describe('executeNativeToolCalls (untrusted model output)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('dispatches every call in a multi-call message, one result each', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'contents');
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const executed = await executeNativeToolCalls(
      nativeToolMessage([
        { name: 'list_files', arguments: '{}' },
        { name: 'read_file', arguments: '{"path":"a.txt"}' },
      ]),
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(executed, 2);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((m) => m.tool_call_id),
      ['call_0', 'call_1'],
    );
    for (const message of messages) {
      assert.equal(message.role, 'tool');
      assert.doesNotThrow(() => JSON.parse(message.content));
    }
  });

  it('intercepts malformed argument JSON with a resend error, not a dispatch', async () => {
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const executed = await executeNativeToolCalls(
      nativeToolMessage([{ name: 'read_file', arguments: 'not json{' }]),
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(executed, 1);
    const result = JSON.parse(messages[0].content);
    assert.match(result.error, /not valid JSON/);
  });

  it('handles repeated identical tool calls', async () => {
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const executed = await executeNativeToolCalls(
      nativeToolMessage([
        { name: 'write_file', arguments: '{"path":"dup.txt","content":"x"}' },
        { name: 'write_file', arguments: '{"path":"dup.txt","content":"y"}' },
      ]),
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(executed, 2);
    assert.equal(messages.length, 2);
    assert.equal(await readFile(join(tmpDir, 'dup.txt'), 'utf8'), 'y');
    assert.deepEqual(registry.filesChanged(), ['dup.txt']);
  });

  it('surfaces model-invented tool names as error results', async () => {
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const executed = await executeNativeToolCalls(
      nativeToolMessage([{ name: 'destroy_everything', arguments: '{}' }]),
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(executed, 1);
    const result = JSON.parse(messages[0].content);
    assert.match(result.error, /unknown tool/i);
  });

  it('repairs unparseable tool-call arguments instead of poisoning history', async () => {
    // A mis-escaped/truncated arguments string: don't dispatch it, repair the
    // stored message to {} so it can't 500 the backend, and feed back a clear
    // error so the model resends.
    const tools = recordingTools();
    const messages = [];
    const message = nativeToolMessage([
      {
        name: 'write_file',
        arguments: '{"path":"a.rs","content":"let s = \\"x\\r\\n;',
      },
    ]);
    const executed = await executeNativeToolCalls(
      message,
      tools,
      messages,
      createNullReporter(),
    );

    assert.equal(executed, 1);
    assert.equal(tools.dispatched.length, 0); // never dispatched garbage
    assert.equal(message.tool_calls[0].function.arguments, '{}'); // repaired in place
    const result = JSON.parse(messages[0].content);
    assert.match(result.error, /not valid JSON/);
  });

  it('recovers a token-polluted native tool name and dispatches the real tool', async () => {
    // The real dogfood mechanism: the call arrives NATIVE with the framing and
    // an echoed result fused into the function name, but correct arguments.
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const executed = await executeNativeToolCalls(
      nativeToolMessage([
        {
          name: '{"written":true,"path":"server.js"}[TOOL_CALLS]write_file',
          arguments: '{"path":"README.md","content":"# TODO API\\n"}',
        },
      ]),
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(executed, 1);
    assert.equal(
      await readFile(join(tmpDir, 'README.md'), 'utf8'),
      '# TODO API\n',
    );
    assert.deepEqual(registry.filesChanged(), ['README.md']);
  });

  it('treats a message with no tool calls as nothing to execute', async () => {
    const registry = createToolRegistry(tmpDir);
    const messages = [];
    const empty = await executeNativeToolCalls(
      { role: 'assistant', content: 'done', tool_calls: [] },
      registry,
      messages,
      createNullReporter(),
    );
    const missing = await executeNativeToolCalls(
      { role: 'assistant', content: 'done' },
      registry,
      messages,
      createNullReporter(),
    );

    assert.equal(empty, 0);
    assert.equal(missing, 0);
    assert.equal(messages.length, 0);
  });
});

// Records each dispatch so tests can assert whether a tool actually ran.
/**
 * @returns {import('../src/tools/index.mjs').ToolRegistry & { dispatched: Array<object> }}
 */
function recordingTools() {
  const dispatched = [];
  return /** @type {import('../src/tools/index.mjs').ToolRegistry & { dispatched: Array<object> }} */ (
    /** @type {any} */ ({
      dispatched,
      definitions: () => [],
      dispatch: async (name, args) => {
        dispatched.push({ name, args });
        return { ok: true };
      },
    })
  );
}

describe('tool hooks in dispatch', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('PreToolUse denial blocks the tool and feeds back an error', async () => {
    const tools = recordingTools();
    const messages = [];
    const hookCtx = {
      pre: [{ run: 'echo blocked >&2; exit 1', name: 'policy' }],
      post: [],
      cwd: tmpDir,
    };
    await executeNativeToolCalls(
      nativeToolMessage([
        { name: 'run_command', arguments: '{"command":"x"}' },
      ]),
      tools,
      messages,
      createNullReporter(),
      hookCtx,
    );

    assert.equal(tools.dispatched.length, 0);
    const result = JSON.parse(messages[0].content);
    assert.match(result.error, /denied by PreToolUse hook "policy"/);
  });

  it('PreToolUse pass lets the tool run', async () => {
    const tools = recordingTools();
    const messages = [];
    const hookCtx = {
      pre: [{ run: 'exit 0', name: 'ok' }],
      post: [],
      cwd: tmpDir,
    };
    await executeNativeToolCalls(
      nativeToolMessage([{ name: 'list_files', arguments: '{}' }]),
      tools,
      messages,
      createNullReporter(),
      hookCtx,
    );

    assert.equal(tools.dispatched.length, 1);
    const result = JSON.parse(messages[0].content);
    assert.equal(result.ok, true);
  });

  it('PostToolUse failure appends hookFeedback but keeps the result', async () => {
    const tools = recordingTools();
    const messages = [];
    const hookCtx = {
      pre: [],
      post: [{ run: 'echo lint-failed >&2; exit 1', name: 'lint' }],
      cwd: tmpDir,
    };
    await executeNativeToolCalls(
      nativeToolMessage([
        { name: 'write_file', arguments: '{"path":"a.txt"}' },
      ]),
      tools,
      messages,
      createNullReporter(),
      hookCtx,
    );

    assert.equal(tools.dispatched.length, 1);
    const result = JSON.parse(messages[0].content);
    assert.equal(result.ok, true);
    assert.match(result.hookFeedback, /PostToolUse hook "lint" failed/);
  });
});
