import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACTION_THRESHOLD,
  compactMessages,
  configuredContextWindow,
  isCompactCommand,
  needsCompaction,
  renderTranscript,
} from '../src/compact.mjs';
import { runToolLoop } from '../src/tool-loop.mjs';

// A scripted client: queued chat() responses returned in order, repeating the
// last once drained. Records every call so tests can assert what was sent.
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

function finalTurn(text, prompt = 2) {
  return {
    message: { role: 'assistant', content: text },
    usage: { prompt, completion: 3 },
  };
}

function toolCallTurn(name, args, prompt = 1) {
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
    usage: { prompt, completion: 1 },
  };
}

const stubTools = {
  definitions: () => [],
  dispatch: async () => ({ ok: true }),
};

describe('needsCompaction', () => {
  it('is false when the context window is zero', () => {
    assert.equal(needsCompaction(9000, 0), false);
  });

  it('is false below the threshold', () => {
    // 0.8 * 1000 = 800
    assert.equal(needsCompaction(799, 1000), false);
  });

  it('is true at or above the threshold', () => {
    assert.equal(needsCompaction(800, 1000), true);
    assert.equal(needsCompaction(950, 1000), true);
  });

  it('is false when prompt tokens are unknown', () => {
    assert.equal(needsCompaction(0, 1000), false);
  });

  it('honors a custom threshold', () => {
    assert.equal(needsCompaction(500, 1000, 0.5), true);
    assert.equal(needsCompaction(499, 1000, 0.5), false);
  });
});

describe('configuredContextWindow', () => {
  const original = process.env.KODR_CONTEXT_WINDOW;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.KODR_CONTEXT_WINDOW;
    } else {
      process.env.KODR_CONTEXT_WINDOW = original;
    }
  });

  it('uses an explicit value', () => {
    assert.equal(configuredContextWindow(4096), 4096);
  });

  it('treats zero as an explicit (disabling) value', () => {
    assert.equal(configuredContextWindow(0), 0);
  });

  it('reads the KODR_CONTEXT_WINDOW env var', () => {
    delete process.env.KODR_CONTEXT_WINDOW;
    process.env.KODR_CONTEXT_WINDOW = '16384';
    assert.equal(configuredContextWindow(undefined), 16384);
  });

  it('returns null when nothing is configured', () => {
    delete process.env.KODR_CONTEXT_WINDOW;
    assert.equal(configuredContextWindow(undefined), null);
  });
});

describe('isCompactCommand', () => {
  it('recognizes "/compact"', () => {
    assert.equal(isCompactCommand('/compact'), true);
    assert.equal(isCompactCommand('  /compact  '), true);
  });

  it('rejects anything else', () => {
    assert.equal(isCompactCommand('compact'), false);
    assert.equal(isCompactCommand('/compact now'), false);
    assert.equal(isCompactCommand(null), false);
  });
});

describe('renderTranscript', () => {
  it('flattens user, assistant, tool-call, and tool messages', () => {
    const text = renderTranscript([
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: 'on it',
        tool_calls: [
          { function: { name: 'read_file', arguments: '{"path":"a.mjs"}' } },
        ],
      },
      { role: 'tool', content: 'file contents' },
    ]);

    assert.match(text, /User:\ndo the thing/);
    assert.match(text, /Assistant:\non it/);
    assert.match(text, /Assistant called read_file\(\{"path":"a.mjs"\}\)/);
    assert.match(text, /Tool result:\nfile contents/);
  });

  it('skips the system message', () => {
    const text = renderTranscript([
      { role: 'system', content: 'SECRET SYSTEM PROMPT' },
      { role: 'user', content: 'hi' },
    ]);
    assert.doesNotMatch(text, /SECRET SYSTEM PROMPT/);
  });
});

describe('compactMessages', () => {
  it('keeps the system message and replaces history with a summary', async () => {
    const client = scriptedClient([finalTurn('SUMMARY OF WORK')]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'doing it' },
      { role: 'tool', content: 'result' },
    ];

    const result = await compactMessages({
      client,
      modelId: 'm',
      messages,
      quiet: true,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.summary, 'SUMMARY OF WORK');
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages[0], {
      role: 'system',
      content: 'system prompt',
    });
    assert.equal(result.messages[1].role, 'user');
    assert.match(result.messages[1].content, /SUMMARY OF WORK/);
    assert.match(result.messages[1].content, /<session-summary>/);

    // The summary request never leaks the original system prompt.
    const sent = client.calls[0].messages;
    assert.equal(sent[0].content.includes('system prompt'), false);
  });

  it('leaves messages unchanged when summarization fails', async () => {
    const client = {
      async chat() {
        throw new Error('model offline');
      },
    };
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
    ];

    const result = await compactMessages({
      client,
      modelId: 'm',
      messages,
      quiet: true,
    });

    assert.equal(result.error, 'model offline');
    assert.deepEqual(result.messages, messages);
  });

  it('reports an empty summary as an error and keeps messages', async () => {
    const client = scriptedClient([finalTurn('   ')]);
    const messages = [
      { role: 'system', content: 'sp' },
      { role: 'user', content: 'task' },
    ];
    const result = await compactMessages({
      client,
      modelId: 'm',
      messages,
      quiet: true,
    });
    assert.equal(result.error, 'empty summary');
    assert.deepEqual(result.messages, messages);
  });

  it('is a no-op when there is no history to compact', async () => {
    const client = scriptedClient([finalTurn('unused')]);
    const messages = [{ role: 'system', content: 'sp' }];
    const result = await compactMessages({
      client,
      modelId: 'm',
      messages,
      quiet: true,
    });
    assert.equal(result.summary, '');
    assert.deepEqual(result.messages, messages);
    assert.equal(client.calls.length, 0);
  });
});

describe('runToolLoop compaction', () => {
  it('compacts in place when a turn crosses the threshold', async () => {
    // Turn 1: a tool call whose request reported 900 prompt tokens (> 80% of
    // 1000). Turn 2 (the compaction summary call) returns the summary. Turn 3
    // is the final answer.
    const client = scriptedClient([
      toolCallTurn('list_files', {}, 900),
      finalTurn('COMPACTED SUMMARY', 5),
      finalTurn('all done', 5),
    ]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
    ];

    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
      contextWindow: 1000,
    });

    assert.equal(loop.completed, true);
    assert.equal(loop.compactions, 1);
    // After compaction the history collapses to system + summary, then the
    // final assistant answer is appended.
    assert.equal(messages[0].content, 'system prompt');
    assert.match(messages[1].content, /COMPACTED SUMMARY/);
    assert.equal(
      messages.some((m) => m.role === 'tool'),
      false,
    );
  });

  it('does not compact when below the threshold', async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}, 100),
      finalTurn('done', 100),
    ]);
    const messages = [
      { role: 'system', content: 'sp' },
      { role: 'user', content: 'task' },
    ];

    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
      contextWindow: 1000,
    });

    assert.equal(loop.compactions, 0);
    assert.ok(messages.some((m) => m.role === 'tool'));
  });

  it('does not compact when the context window is disabled', async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}, 100000),
      finalTurn('done', 100000),
    ]);
    const messages = [{ role: 'system', content: 'sp' }];

    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
      contextWindow: 0,
    });

    assert.equal(loop.compactions, 0);
  });

  it('continues uncompacted when the summary call fails', async () => {
    let chatCalls = 0;
    const client = {
      calls: [],
      async chat(params) {
        chatCalls++;
        // First call: a tool call that crosses the threshold.
        if (chatCalls === 1) {
          return toolCallTurn('list_files', {}, 900);
        }
        // Second call is the compaction summary — fail it.
        if (chatCalls === 2) {
          throw new Error('summary failed');
        }
        return finalTurn('done anyway', 50);
      },
    };
    const messages = [
      { role: 'system', content: 'sp' },
      { role: 'user', content: 'task' },
    ];

    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
      contextWindow: 1000,
    });

    assert.equal(loop.completed, true);
    assert.equal(loop.compactions, 0);
    // History was preserved since compaction failed.
    assert.ok(messages.some((m) => m.role === 'tool'));
  });
});

describe('constants', () => {
  it('defaults the threshold to 80%', () => {
    assert.equal(COMPACTION_THRESHOLD, 0.8);
  });
});
