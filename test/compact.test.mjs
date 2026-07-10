import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHARS_PER_TOKEN,
  COMPACTION_THRESHOLD,
  compactMessageChars,
  compactMessages,
  compactTaskChars,
  configuredContextWindow,
  DEFAULT_COMPACT_MESSAGE_CHARS,
  DEFAULT_COMPACT_TASK_CHARS,
  estimateTokens,
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

describe('estimateTokens', () => {
  it('estimates from content length at the default ratio', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(40) }];
    assert.equal(estimateTokens(messages), 40 / CHARS_PER_TOKEN);
  });

  it('counts assistant tool-call names and arguments', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: '{"path":"a.mjs"}' } },
        ],
      },
    ];
    // 'read_file' (9) + '{"path":"a.mjs"}' (16) = 25 chars.
    assert.equal(estimateTokens(messages), Math.ceil(25 / CHARS_PER_TOKEN));
  });

  it('honors an overridable chars-per-token ratio', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(40) }];
    assert.equal(estimateTokens(messages, 8), 5);
  });

  it('ignores messages with non-string content', () => {
    assert.equal(estimateTokens([{ role: 'tool', content: null }]), 0);
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

  it('keeps the first user (task) message in full when under the task cap, bounding later ones', () => {
    const task = `TASK ${'t'.repeat(5000)}`;
    const laterUser = `FOLLOWUP ${'u'.repeat(5000)}`;
    const text = renderTranscript(
      [
        { role: 'user', content: task },
        { role: 'assistant', content: `THOUGHT ${'a'.repeat(5000)}` },
        { role: 'tool', content: `RESULT ${'r'.repeat(5000)}` },
        { role: 'user', content: laterUser },
      ],
      100,
    );
    // The task is preserved in full; everything after it is truncated.
    assert.ok(text.includes(task));
    assert.doesNotMatch(text, /a{5000}/);
    assert.doesNotMatch(text, /r{5000}/);
    assert.doesNotMatch(text, /u{5000}/);
    assert.match(text, /… \[truncated\]/);
  });

  it('bounds a pathologically large task message at the task cap', () => {
    // The task is kept at a larger bound than other messages, but still
    // bounded -- so a huge task prompt cannot alone overflow the summarize
    // request and leave the run stuck over-window.
    const task = `TASK ${'t'.repeat(5000)}`;
    const text = renderTranscript(
      [{ role: 'user', content: task }],
      100, // other-message cap
      200, // task cap
    );
    assert.doesNotMatch(text, /t{5000}/);
    assert.match(text, /… \[truncated\]/);
    // The task cap is larger than the other-message cap: the kept prefix is
    // longer than 100 chars.
    assert.ok(text.includes(`TASK ${'t'.repeat(150)}`));
  });

  it('renders an image user message as a placeholder, not array content', () => {
    const text = renderTranscript([
      { role: 'user', content: 'the task' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image scan.png:' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,BIGBLOB' },
          },
        ],
      },
    ]);
    assert.match(text, /Image scan\.png: \[image\]/);
    assert.doesNotMatch(text, /BIGBLOB/);
  });

  it('truncates a huge tool_call argument blob', () => {
    const text = renderTranscript(
      [
        { role: 'user', content: 'task' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'write_file',
                arguments: `{"content":"${'x'.repeat(5000)}"}`,
              },
            },
          ],
        },
      ],
      100,
    );
    assert.doesNotMatch(text, /x{5000}/);
    assert.match(text, /Assistant called write_file\(/);
  });
});

describe('compactMessageChars', () => {
  const original = process.env.KODR_COMPACT_MESSAGE_CHARS;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.KODR_COMPACT_MESSAGE_CHARS;
    } else {
      process.env.KODR_COMPACT_MESSAGE_CHARS = original;
    }
  });

  it('uses an explicit option, then the env var, then the default', () => {
    delete process.env.KODR_COMPACT_MESSAGE_CHARS;
    assert.equal(compactMessageChars(500), 500);
    assert.equal(compactMessageChars(undefined), DEFAULT_COMPACT_MESSAGE_CHARS);
    process.env.KODR_COMPACT_MESSAGE_CHARS = '1234';
    assert.equal(compactMessageChars(undefined), 1234);
    assert.equal(compactMessageChars(500), 500);
  });
});

describe('compactTaskChars', () => {
  const original = process.env.KODR_COMPACT_TASK_CHARS;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.KODR_COMPACT_TASK_CHARS;
    } else {
      process.env.KODR_COMPACT_TASK_CHARS = original;
    }
  });

  it('uses an explicit option, then the env var, then the default', () => {
    delete process.env.KODR_COMPACT_TASK_CHARS;
    assert.equal(compactTaskChars(9000), 9000);
    assert.equal(compactTaskChars(undefined), DEFAULT_COMPACT_TASK_CHARS);
    process.env.KODR_COMPACT_TASK_CHARS = '5678';
    assert.equal(compactTaskChars(undefined), 5678);
    assert.equal(compactTaskChars(9000), 9000);
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

  it('bounds the summarize request so a huge message cannot overflow it', async () => {
    const client = scriptedClient([finalTurn('SUMMARY')]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'the original task' },
      { role: 'assistant', content: 'x'.repeat(200_000) },
      { role: 'tool', content: 'y'.repeat(200_000) },
    ];

    await compactMessages({
      client,
      modelId: 'm',
      messages,
      quiet: true,
      maxMessageChars: 2000,
    });

    // The transcript sent to the summary model is bounded well under the raw
    // 400k of history, while the original task survives.
    const sent = client.calls[0].messages[1].content;
    assert.ok(sent.length < 20_000, `transcript too large: ${sent.length}`);
    assert.match(sent, /the original task/);
  });

  it('forwards timeoutMs to the summary chat call', async () => {
    const client = scriptedClient([finalTurn('SUMMARY OF WORK')]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
    ];

    await compactMessages({
      client,
      modelId: 'm',
      messages,
      quiet: true,
      timeoutMs: 5000,
    });

    assert.equal(client.calls[0].timeoutMs, 5000);
  });

  it('forwards heartbeatMs and onHeartbeat to the summary chat call', async () => {
    const client = scriptedClient([finalTurn('SUMMARY OF WORK')]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
    ];
    const onHeartbeat = () => {};

    await compactMessages({
      client,
      modelId: 'm',
      messages,
      quiet: true,
      heartbeatMs: 5000,
      onHeartbeat,
    });

    assert.equal(client.calls[0].heartbeatMs, 5000);
    assert.equal(client.calls[0].onHeartbeat, onHeartbeat);
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

  it('reports retries used by the summary chat call', async () => {
    const client = scriptedClient([
      { ...finalTurn('SUMMARY OF WORK'), retries: 1 },
    ]);
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

    assert.equal(result.retries, 1);
  });

  it('reports retries from the error when summarization ultimately fails', async () => {
    const client = {
      async chat() {
        const err = new Error('model offline');
        err.retries = 1;
        throw err;
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

    assert.equal(result.retries, 1);
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

  it('compacts using an estimate when the provider reports no prompt usage', async () => {
    // A provider like Ollama reports prompt: 0. Without an estimate fallback,
    // needsCompaction(0, ...) is always false and the session never compacts.
    // Turn 1 is a tool call with zero usage but a large conversation, so the
    // estimated size crosses the threshold and compaction fires.
    const client = scriptedClient([
      toolCallTurn('list_files', {}, 0),
      finalTurn('COMPACTED SUMMARY', 0),
      finalTurn('all done', 0),
    ]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      // ~2000 chars / 4 = ~500 estimated tokens, over 0.8 * 500 = 400.
      { role: 'user', content: 'x'.repeat(2000) },
    ];

    const loop = await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
      contextWindow: 500,
    });

    assert.equal(loop.completed, true);
    assert.equal(loop.compactions, 1);
    assert.match(messages[1].content, /COMPACTED SUMMARY/);
  });

  it("adds the compaction summary call's retries to the run total", async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}, 900),
      { ...finalTurn('COMPACTED SUMMARY', 5), retries: 2 },
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

    assert.equal(loop.compactions, 1);
    assert.equal(loop.retries, 2);
  });

  it('forwards heartbeatMs and onHeartbeat to the compaction summary call', async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}, 900),
      finalTurn('COMPACTED SUMMARY', 5),
      finalTurn('all done', 5),
    ]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
    ];
    const onHeartbeat = () => {};

    await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
      contextWindow: 1000,
      heartbeatMs: 5000,
      onHeartbeat,
    });

    // Call index 1 is the compaction summary request.
    assert.equal(client.calls[1].heartbeatMs, 5000);
    assert.equal(client.calls[1].onHeartbeat, onHeartbeat);
  });

  it('caps the compaction summary call to the remaining run budget', async () => {
    const client = scriptedClient([
      toolCallTurn('list_files', {}, 900),
      finalTurn('COMPACTED SUMMARY', 5),
      finalTurn('all done', 5),
    ]);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
    ];
    const startedAt = new Date(Date.now() - 9_000);

    await runToolLoop({
      client,
      modelId: 'm',
      messages,
      tools: stubTools,
      quiet: true,
      contextWindow: 1000,
      startedAt,
      maxRunMs: 10_000,
    });

    // Call 0 is the turn that triggers compaction, call 1 is the summary
    // request itself — it must not get a fresh 10s timeout.
    assert.ok(client.calls[1].timeoutMs <= 1000);
    assert.ok(client.calls[1].timeoutMs > 0);
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
