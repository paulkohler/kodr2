import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MAX_TOOL_TURNS,
  executeNativeToolCalls,
  executeRecoveredTextToolCall,
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
      true,
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
      true,
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
      true,
    );

    assert.equal(recovered, true);
    assert.equal(messages.length, 2);
    assert.equal(await readFile(join(tmpDir, 'a.txt'), 'utf8'), 'a');
    assert.equal(await readFile(join(tmpDir, 'b.txt'), 'utf8'), 'b');
  });
});

// A scripted model client: returns queued responses in order, repeating the
// last one once the queue is drained. Records every chat() call.
function scriptedClient(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat(params) {
      calls.push(params);
      const response = responses[Math.min(i, responses.length - 1)];
      i++;
      return response;
    },
  };
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

const stubTools = {
  definitions: () => [],
  dispatch: async () => ({ ok: true }),
};

describe('runToolLoop', () => {
  it('completes when the model answers with no tool call', async () => {
    const client = scriptedClient([finalTurn('done')]);
    const messages = [];
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
    });

    assert.equal(loop.completed, true);
    assert.equal(loop.stoppedReason, 'complete');
    assert.equal(loop.finalText, 'done');
    assert.equal(loop.toolTurns, 0);
    assert.deepEqual(loop.usage, { prompt: 2, completion: 3 });
  });

  it('runs a tool call then completes, accumulating usage', async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}),
      finalTurn('fixed'),
    ]);
    let dispatched = 0;
    const tools = {
      definitions: () => [],
      dispatch: async () => {
        dispatched++;
        return { ok: true };
      },
    };
    const messages = [];
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools,
      quiet: true,
    });

    assert.equal(dispatched, 1);
    assert.equal(loop.toolTurns, 1);
    assert.equal(loop.completed, true);
    assert.equal(loop.finalText, 'fixed');
    assert.deepEqual(loop.usage, { prompt: 3, completion: 4 });
    assert.ok(messages.some((m) => m.role === 'tool'));
  });

  it('stops at the tool-turn ceiling when the model never finishes', async () => {
    const client = scriptedClient([toolCallTurn('list_files', {})]);
    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages: [],
      tools: stubTools,
      quiet: true,
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
      quiet: true,
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
      quiet: true,
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
      quiet: true,
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
      quiet: true,
    });

    assert.equal(client.calls[0].timeoutMs, undefined);
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
      true,
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
      true,
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
      true,
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
      true,
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
      true,
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
      true,
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
      true,
    );
    const missing = await executeNativeToolCalls(
      { role: 'assistant', content: 'done' },
      registry,
      messages,
      true,
    );

    assert.equal(empty, 0);
    assert.equal(missing, 0);
    assert.equal(messages.length, 0);
  });
});

// Records each dispatch so tests can assert whether a tool actually ran.
function recordingTools() {
  const dispatched = [];
  return {
    dispatched,
    definitions: () => [],
    dispatch: async (name, args) => {
      dispatched.push({ name, args });
      return { ok: true };
    },
  };
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
      true,
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
      true,
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
      true,
      hookCtx,
    );

    assert.equal(tools.dispatched.length, 1);
    const result = JSON.parse(messages[0].content);
    assert.equal(result.ok, true);
    assert.match(result.hookFeedback, /PostToolUse hook "lint" failed/);
  });
});
