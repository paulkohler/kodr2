import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MAX_TOOL_TURNS,
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
});
