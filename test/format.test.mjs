import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatToolCall,
  formatToolResult,
  formatVerification,
  formatHealTurn,
  formatNotice,
  formatSummary,
  formatModelsList,
} from '../src/format.mjs';

// Strip ANSI escapes so assertions read against plain text.
function plain(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatToolCall', () => {
  it('includes tool name', () => {
    const out = formatToolCall('read_file', { path: 'src/app.mjs' });
    assert.ok(out.includes('read_file'));
  });

  it('includes path for file tools', () => {
    const out = formatToolCall('read_file', { path: 'hello.txt' });
    assert.ok(out.includes('hello.txt'));
  });

  it('includes command for run_command', () => {
    const out = formatToolCall('run_command', { command: 'npm test' });
    assert.ok(out.includes('npm test'));
  });
});

describe('formatToolResult', () => {
  it('shows ok for success', () => {
    const out = formatToolResult('read_file', { content: 'hello' });
    assert.ok(out.includes('ok'));
  });

  it('shows error for failures', () => {
    const out = formatToolResult('read_file', { error: 'not found' });
    assert.ok(out.includes('error'));
    assert.ok(out.includes('not found'));
  });

  it('shows line count for read_file', () => {
    const out = formatToolResult('read_file', { content: 'a\nb\nc' });
    assert.ok(out.includes('3 lines'));
  });
});

describe('formatVerification', () => {
  it('shows pass for passing verification', () => {
    const out = formatVerification({
      passed: true,
      command: 'npm test',
      output: '',
    });
    assert.ok(out.includes('pass'));
  });

  it('shows fail with output for failing verification', () => {
    const out = formatVerification({
      passed: false,
      command: 'npm test',
      output: 'Error at line 5',
    });
    assert.ok(out.includes('fail'));
    assert.ok(out.includes('Error at line 5'));
  });
});

describe('formatHealTurn', () => {
  it('shows turn number', () => {
    const out = formatHealTurn(2, 3);
    assert.ok(out.includes('2/3'));
  });
});

describe('formatNotice', () => {
  it('includes the message text', () => {
    const out = formatNotice('stopped after 20 tool turns');
    assert.ok(out.includes('stopped after 20 tool turns'));
  });
});

describe('formatSummary', () => {
  it('includes files changed', () => {
    const out = formatSummary({ filesChanged: ['a.mjs', 'b.mjs'] });
    assert.ok(out.includes('a.mjs'));
    assert.ok(out.includes('b.mjs'));
  });

  it('includes token usage', () => {
    const out = formatSummary({ usage: { prompt: 100, completion: 50 } });
    assert.ok(out.includes('100'));
    assert.ok(out.includes('50'));
  });
});

describe('formatModelsList', () => {
  it('shows loaded/max windows and flags headroom', () => {
    const out = plain(
      formatModelsList(
        [
          {
            id: 'google/gemma',
            state: 'loaded',
            loaded_context_length: 32768,
            max_context_length: 262144,
          },
          {
            id: 'openai/gpt-oss',
            state: 'not-loaded',
            max_context_length: 131072,
          },
        ],
        'http://localhost:1234/v1',
      ),
    );

    assert.match(out, /google\/gemma/);
    assert.match(out, /loaded 32768 \/ 262144 max/);
    assert.match(out, /8× headroom/);
    // Not-loaded models show only their max, no headroom marker.
    assert.match(out, /openai\/gpt-oss {2}131072 max/);
    assert.match(out, /reloaded with a larger context length/);
  });

  it('does not warn when the loaded model is near its max', () => {
    const out = plain(
      formatModelsList([
        {
          id: 'm',
          state: 'loaded',
          loaded_context_length: 32768,
          max_context_length: 32768,
        },
      ]),
    );
    assert.doesNotMatch(out, /headroom/);
    assert.doesNotMatch(out, /reloaded with a larger context/);
  });

  it('reports when no models are available', () => {
    const out = plain(formatModelsList([], 'http://localhost:1234/v1'));
    assert.match(out, /No models reported/);
  });
});
