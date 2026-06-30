import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, toMarkdown } from '../eval/arena/report.mjs';

const JOBS = [
  // baseline: one task, two repeats, neither passes
  {
    task: 't',
    variant: 'baseline',
    passed: false,
    toolTurns: 4,
    promptTokens: 100,
    completionTokens: 20,
    stoppedReason: 'complete',
  },
  {
    task: 't',
    variant: 'baseline',
    passed: false,
    toolTurns: 2,
    promptTokens: 80,
    completionTokens: 10,
    stoppedReason: 'error',
  },
  // heal: one task, two repeats, one passes via heal
  {
    task: 't',
    variant: 'heal',
    passed: true,
    toolTurns: 6,
    promptTokens: 200,
    completionTokens: 40,
    healed: true,
    stoppedReason: 'complete',
  },
  {
    task: 't',
    variant: 'heal',
    passed: false,
    toolTurns: 5,
    promptTokens: 150,
    completionTokens: 30,
    stoppedReason: 'complete',
  },
];

describe('aggregate', () => {
  it('summarizes per variant with pass@k, cost, heals, and aborts', () => {
    const rows = aggregate(JOBS);
    const baseline = rows.find((r) => r.variant === 'baseline');
    const heal = rows.find((r) => r.variant === 'heal');

    // baseline: the single task never passed across repeats -> pass@k 0
    assert.equal(baseline.passAtK, 0);
    assert.equal(baseline.runs, 2);
    assert.equal(baseline.aborted, 1);
    assert.equal(baseline.heals, 0);
    assert.equal(baseline.meanTurns, 3); // (4 + 2) / 2

    // heal: the task passed in at least one repeat -> pass@k 1
    assert.equal(heal.passAtK, 1);
    assert.equal(heal.heals, 1);
    assert.equal(heal.meanTokens, (240 + 180) / 2);
  });

  it('groups runs by variant', () => {
    const rows = aggregate(JOBS);
    assert.equal(rows.length, 2);
  });
});

describe('toMarkdown', () => {
  it('renders a table with a row per variant', () => {
    const md = toMarkdown(aggregate(JOBS));
    assert.match(md, /\| variant \| pass@k \|/);
    assert.match(md, /\| baseline \| 0% \|/);
    assert.match(md, /\| heal \| 100% \|/);
  });
});
