import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import telegram, {
  renderSummary,
  renderToolCall,
  renderTurn,
  serialize,
  truncate,
} from '../src/plugins/telegram.mjs';

const creds = { KODR_TELEGRAM_TOKEN: 't', KODR_TELEGRAM_CHAT_ID: '42' };

/** setup() with an injected transport that records what it sends. */
function setupWith(env) {
  const sent = [];
  const state = telegram.setup(
    { transport: (text) => sent.push(text) },
    { env },
  );
  return { state, sent };
}

describe('telegram setup', () => {
  it('returns an error when the token is missing', () => {
    const state = telegram.setup({}, { env: { KODR_TELEGRAM_CHAT_ID: '42' } });
    assert.match(state.error, /KODR_TELEGRAM_TOKEN/);
  });

  it('returns an error when the chat id is missing', () => {
    const state = telegram.setup({}, { env: { KODR_TELEGRAM_TOKEN: 't' } });
    assert.match(state.error, /KODR_TELEGRAM_CHAT_ID/);
  });

  it('returns a reporter when credentials are present', () => {
    const { state } = setupWith(creds);
    assert.equal(typeof state.token, 'function');
    assert.equal(typeof state.turnEnd, 'function');
  });
});

describe('telegram reporter', () => {
  it('flushes accumulated token text as one message on turnEnd', async () => {
    const { state, sent } = setupWith(creds);
    state.token('Hello ');
    state.token('world');
    assert.deepEqual(sent, []); // buffered, nothing sent yet
    await state.turnEnd({ completed: true });
    assert.deepEqual(sent, ['💬 Hello world']);
  });

  it('sends nothing for a tool-only turn (empty text)', async () => {
    const { state, sent } = setupWith(creds);
    await state.turnEnd({ completed: false });
    assert.deepEqual(sent, []);
  });

  it('sends a tool call with its argument summary', async () => {
    const { state, sent } = setupWith(creds);
    await state.toolCall({ name: 'read_file', args: { path: 'a.mjs' } });
    assert.equal(sent[0], '🔧 read_file {"path":"a.mjs"}');
  });

  it('sends a compact run summary', async () => {
    const { state, sent } = setupWith(creds);
    await state.summary({
      filesChanged: ['a.mjs'],
      verification: { passed: true },
      usage: { prompt: 10, completion: 20 },
    });
    assert.match(sent[0], /run complete/);
    assert.match(sent[0], /files: a\.mjs/);
    assert.match(sent[0], /verify: pass/);
    assert.match(sent[0], /tokens: 10 in \/ 20 out/);
  });
});

describe('telegram rendering', () => {
  it('renders assistant turn text', () => {
    assert.equal(renderTurn('hello'), '💬 hello');
  });

  it('renders empty turn text as an empty string', () => {
    assert.equal(renderTurn('   '), '');
  });

  it('renders a tool call with an argument summary', () => {
    assert.equal(
      renderToolCall({ name: 'read_file', args: { path: 'a.mjs' } }),
      '🔧 read_file {"path":"a.mjs"}',
    );
  });

  it('renders a summary with only the header when result is empty', () => {
    assert.equal(renderSummary({}), '✅ run complete');
  });
});

describe('truncate', () => {
  it('leaves short messages unchanged', () => {
    assert.equal(truncate('short'), 'short');
  });

  it('caps a message at 4096 characters with a marker', () => {
    const out = truncate('a'.repeat(5000));
    assert.ok(out.length <= 4096);
    assert.match(out, /truncated/);
  });
});

describe('serialize', () => {
  it('delivers messages in order through the transport', async () => {
    const sent = [];
    const send = serialize(async (text) => {
      sent.push(text);
    });

    send('first');
    await send('second');

    assert.deepEqual(sent, ['first', 'second']);
  });

  it('truncates before sending', async () => {
    const sent = [];
    const send = serialize(async (text) => sent.push(text));
    await send('a'.repeat(5000));
    assert.ok(sent[0].length <= 4096);
  });

  it('swallows a transport rejection without breaking the chain', async () => {
    const sent = [];
    const send = serialize(async (text) => {
      if (text === 'bad') {
        throw new Error('network');
      }
      sent.push(text);
    });

    send('bad');
    await assert.doesNotReject(() => send('good'));
    assert.deepEqual(sent, ['good']);
  });
});
