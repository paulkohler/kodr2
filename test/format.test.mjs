import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatCost,
  formatDoctorReport,
  formatHealTurn,
  formatHeartbeat,
  formatModelsList,
  formatNotice,
  formatPlan,
  formatStats,
  formatStepUpdate,
  formatSummary,
  formatToolCall,
  formatToolResult,
  formatVerification,
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

  it('includes path and glob for search, not just the pattern', () => {
    const out = plain(
      formatToolCall('search', {
        pattern: 'rule_syntax',
        path: 'bottle.py',
        glob: '.py',
      }),
    );
    assert.ok(out.includes('rule_syntax'));
    assert.ok(out.includes('bottle.py'));
    assert.ok(out.includes('.py'));
  });

  it('shows only the pattern for search when no path or glob given', () => {
    const out = plain(formatToolCall('search', { pattern: 'target' }));
    assert.ok(out.includes('target'));
    assert.ok(!out.includes('('));
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

describe('formatPlan', () => {
  const steps = [
    { id: 1, title: 'Set up the repo' },
    { id: 2, title: 'Write the hook' },
  ];

  it('shows the step count and one numbered line per title', () => {
    const out = plain(formatPlan(steps, false));
    assert.ok(out.includes('plan 2 steps'));
    assert.ok(out.includes('1. Set up the repo'));
    assert.ok(out.includes('2. Write the hook'));
  });

  it('uses the singular for one step and flags a degraded plan', () => {
    const out = plain(formatPlan([{ id: 1, title: 'Do it' }], true));
    assert.ok(out.includes('plan 1 step'));
    assert.ok(out.includes('degraded to a single step'));
  });
});

describe('formatStepUpdate', () => {
  it('shows the title when a step starts running', () => {
    const out = plain(
      formatStepUpdate({
        id: 2,
        total: 4,
        title: 'Write hook',
        status: 'running',
      }),
    );
    assert.ok(out.includes('step 2/4'));
    assert.ok(out.includes('Write hook'));
  });

  it('shows done without repeating the title', () => {
    const out = plain(
      formatStepUpdate({
        id: 2,
        total: 4,
        title: 'Write hook',
        status: 'done',
      }),
    );
    assert.ok(out.includes('step 2/4 done'));
    assert.ok(!out.includes('Write hook'));
  });

  it('shows failed with the stop reason', () => {
    const out = plain(
      formatStepUpdate({
        id: 2,
        total: 4,
        title: 'Write hook',
        status: 'failed',
        stoppedReason: 'tool-limit',
      }),
    );
    assert.ok(out.includes('step 2/4 failed (tool-limit)'));
  });
});

describe('formatHeartbeat', () => {
  it('includes the hook name and elapsed seconds', () => {
    const out = plain(formatHeartbeat('test', 65_000));
    assert.ok(out.includes('test'));
    assert.ok(out.includes('65s'));
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
    const out = formatSummary({
      usage: { prompt: 100, completion: 50, cost: 0 },
    });
    assert.ok(out.includes('100'));
    assert.ok(out.includes('50'));
  });

  it('includes retries when at least one happened', () => {
    const out = formatSummary({ retries: 2 });
    assert.ok(out.includes('retries'));
    assert.ok(out.includes('2'));
  });

  it('omits the retries line when there were none', () => {
    const out = formatSummary({ retries: 0 });
    assert.ok(!out.includes('retries'));
  });

  it('includes cost when nonzero', () => {
    const out = formatSummary({
      usage: { prompt: 100, completion: 50, cost: 0.0042 },
    });
    assert.ok(out.includes('$0.0042'));
  });

  it('omits cost when zero (e.g. a local backend like LM Studio)', () => {
    const out = formatSummary({
      usage: { prompt: 100, completion: 50, cost: 0 },
    });
    assert.ok(!out.includes('$'));
  });
});

describe('formatCost', () => {
  it('formats a USD cost to 4 decimal places', () => {
    assert.equal(formatCost(0.0042), '$0.0042');
    assert.equal(formatCost(1.5), '$1.5000');
    assert.equal(formatCost(0), '$0.0000');
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

describe('formatDoctorReport', () => {
  it("renders each check's status icon, name, and detail", () => {
    const out = plain(
      formatDoctorReport({
        ok: false,
        checks: [
          { name: 'Node.js version', status: 'ok', detail: 'v22.1.0' },
          { name: 'git', status: 'warn', detail: 'git not found' },
          { name: 'LM Studio', status: 'fail', detail: 'not reachable' },
        ],
      }),
    );

    assert.match(out, /✓ Node\.js version.*v22\.1\.0/);
    assert.match(out, /⚠ git.*git not found/);
    assert.match(out, /✗ LM Studio.*not reachable/);
    assert.match(out, /failed/);
  });

  it('reports ok with no failure line when every check passes', () => {
    const out = plain(
      formatDoctorReport({
        ok: true,
        checks: [{ name: 'git', status: 'ok', detail: 'git version 2.42.0' }],
      }),
    );
    assert.match(out, /\bok\b/);
    assert.doesNotMatch(out, /failed/);
  });
});

describe('formatStats', () => {
  it('renders totals, stopped reasons, and every rate', () => {
    const out = plain(
      formatStats({
        total: 4,
        stoppedReasonCounts: { complete: 3, error: 1 },
        noOpRate: 0.25,
        healAttemptedRate: 0.5,
        healSuccessRate: 1,
        compactionRate: 0.25,
        avgCompactions: 0.5,
        retryRate: 0.5,
        avgRetries: 0.75,
        verifyAttemptedRate: 0.5,
        verifyPassRate: 1,
        avgToolTurns: 3.5,
        avgDurationMs: 1234,
        totalUsage: { prompt: 100, completion: 40, cost: 0 },
      }),
    );

    assert.match(out, /4 runs/);
    assert.match(out, /complete: 3, error: 1/);
    assert.match(out, /25%/);
    assert.match(out, /1234ms/);
    assert.match(out, /100 in \/ 40 out/);
  });

  it('includes total cost when nonzero', () => {
    const out = plain(
      formatStats({
        total: 1,
        stoppedReasonCounts: { complete: 1 },
        noOpRate: 0,
        healAttemptedRate: 0,
        healSuccessRate: null,
        compactionRate: 0,
        avgCompactions: 0,
        retryRate: 0,
        avgRetries: 0,
        verifyAttemptedRate: 0,
        verifyPassRate: null,
        avgToolTurns: 1,
        avgDurationMs: null,
        totalUsage: { prompt: 100, completion: 40, cost: 0.0123 },
      }),
    );
    assert.match(out, /100 in \/ 40 out \(\$0\.0123\)/);
  });

  it('renders "n/a" for a null rate rather than an empty or NaN value', () => {
    const out = plain(
      formatStats({
        total: 2,
        stoppedReasonCounts: { complete: 2 },
        noOpRate: 0,
        healAttemptedRate: 0,
        healSuccessRate: null,
        compactionRate: 0,
        avgCompactions: 0,
        retryRate: 0,
        avgRetries: 0,
        verifyAttemptedRate: 0,
        verifyPassRate: null,
        avgToolTurns: 1,
        avgDurationMs: null,
        totalUsage: { prompt: 0, completion: 0, cost: 0 },
      }),
    );

    assert.doesNotMatch(out, /NaN/);
    assert.match(out, /n\/a/);
  });

  it('reports no run records found for an empty set', () => {
    const out = plain(formatStats({ total: 0 }));
    assert.match(out, /No run records found/);
  });
});
