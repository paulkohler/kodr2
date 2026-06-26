import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatToolCall,
  formatToolResult,
  formatVerification,
  formatHealTurn,
  formatNotice,
  formatSummary,
} from '../src/format.mjs';

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
