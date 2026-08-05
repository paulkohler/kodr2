import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GOAL_LABELS, parseVerdict, REVIEW_LABELS } from '../src/verdict.mjs';

const review = (text) => parseVerdict(text, REVIEW_LABELS);
const goal = (text) => parseVerdict(text, GOAL_LABELS);

describe('parseVerdict', () => {
  it('reads an anchored verdict line as passed', () => {
    const parsed = review('Looks correct.\n\nVERDICT: PASS');
    assert.equal(parsed.passed, true);
    assert.equal(parsed.found, true);
    assert.equal(parsed.ambiguous, false);
  });

  it('reads an anchored negative verdict line as not passed', () => {
    const parsed = review('greet.mjs has a broken import.\n\nVERDICT: FAIL');
    assert.equal(parsed.passed, false);
    assert.equal(parsed.found, true);
  });

  it('reads the goal labels, MET and NOT MET', () => {
    assert.equal(goal('All routes scoped.\n\nVERDICT: MET').passed, true);
    assert.equal(goal('Deals are missing.\n\nVERDICT: NOT MET').passed, false);
  });

  it('prefers NOT MET over the bare MET when both could match', () => {
    const parsed = goal('VERDICT: NOT MET');
    assert.equal(parsed.passed, false);
    assert.equal(parsed.found, true);
  });

  it('ignores a verdict written inside a think block', () => {
    // The exact hazard: a reasoning model reaching for one answer, then
    // talking itself into the other. Only the visible reply counts.
    const parsed = review(
      '<think>\nSo the VERDICT: PASS unless the tests are stubbed.\n' +
        'Checking... they are stubbed.\n</think>\n' +
        'The tests assert nothing.\n\nVERDICT: FAIL',
    );
    assert.equal(parsed.passed, false);
    assert.equal(parsed.found, true);
    assert.match(parsed.thinking, /unless the tests are stubbed/);
    assert.doesNotMatch(parsed.feedback, /unless the tests are stubbed/);
  });

  it('reports not found when the only verdict is inside an unterminated think block', () => {
    const parsed = review('<think>\nI think VERDICT: PASS is right, but');
    assert.equal(parsed.found, false);
    assert.equal(parsed.passed, false);
  });

  it('prefers an anchored verdict line over a mid-sentence mention', () => {
    const parsed = review(
      'I will end with VERDICT: PASS or VERDICT: FAIL as instructed.\n' +
        'The import is broken.\n\nVERDICT: FAIL',
    );
    assert.equal(parsed.passed, false);
    assert.equal(parsed.found, true);
  });

  it('falls back to an unanchored match when no anchored line exists', () => {
    // Back-compat: today's goal judge parses replies shaped like this.
    const parsed = goal('Everything checks out, so VERDICT: MET here.');
    assert.equal(parsed.passed, true);
    assert.equal(parsed.found, true);
  });

  it('returns found false and passed false when there is no verdict at all', () => {
    const parsed = review('No findings.');
    assert.equal(parsed.found, false);
    assert.equal(parsed.passed, false);
    assert.equal(parsed.feedback, 'No findings.');
  });

  it('returns passed false for a garbled or truncated verdict marker', () => {
    for (const text of ['VERDICT: PAS', 'VERDICT:', 'VERD1CT: PASS', 'PASS']) {
      const parsed = review(text);
      assert.equal(parsed.passed, false, `should not pass: ${text}`);
    }
  });

  it('returns passed false and ambiguous true when two anchored lines disagree', () => {
    const parsed = review('VERDICT: PASS\nOn reflection:\nVERDICT: FAIL');
    assert.equal(parsed.passed, false);
    assert.equal(parsed.found, true);
    assert.equal(parsed.ambiguous, true);
  });

  it('tolerates a bullet, bold markers, or a trailing period around the verdict line', () => {
    for (const line of [
      '- VERDICT: PASS',
      '**VERDICT: PASS**',
      '> VERDICT: PASS',
      'VERDICT: PASS.',
      '  VERDICT:  PASS  ',
    ]) {
      const parsed = review(`Fine.\n${line}`);
      assert.equal(parsed.passed, true, `should pass: ${line}`);
      assert.equal(parsed.ambiguous, false);
    }
  });

  it('strips every verdict line out of the feedback', () => {
    const parsed = review('One finding.\nVERDICT: FAIL\nVERDICT: FAIL');
    assert.equal(parsed.feedback, 'One finding.');
  });

  it('returns the whole visible reply as feedback when stripping leaves nothing', () => {
    const parsed = review('VERDICT: PASS');
    assert.equal(parsed.feedback, 'VERDICT: PASS');
  });

  it('returns the think-block contents as thinking, never as feedback', () => {
    const parsed = review(
      '<think>\nscratch work\n</think>\nA finding.\nVERDICT: FAIL',
    );
    assert.equal(parsed.thinking, 'scratch work');
    assert.equal(parsed.feedback, 'A finding.');
  });

  it('treats a non-string input as an absent verdict', () => {
    for (const input of [undefined, null, 42, {}]) {
      const parsed = review(input);
      assert.equal(parsed.found, false);
      assert.equal(parsed.passed, false);
      assert.equal(parsed.feedback, '');
    }
  });
});
