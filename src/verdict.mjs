/**
 * Parse a model's final reply into a verdict.
 *
 * Two features need this and they use different words for the same thing: the
 * goal judge ends with MET or NOT MET (specs/goal.yaml), the review pass with
 * PASS or FAIL (specs/review.yaml). One parser with a label set per caller,
 * rather than a regex each -- because the interesting parts (ignore the think
 * block, prefer an anchored line, fail closed) are exactly what a second copy
 * would get subtly wrong.
 */

import { splitThinking } from './think.mjs';

export const GOAL_LABELS = { pass: 'MET', fail: 'NOT MET' };
export const REVIEW_LABELS = { pass: 'PASS', fail: 'FAIL' };

const MARKER = 'VERDICT';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest label first so "NOT MET" wins over the bare "MET" it contains.
// Whitespace between words is flexible: a model that wraps its reply, or emits
// "NOT  MET", still parses.
function labelAlternation(labels) {
  return [labels.fail, labels.pass]
    .map((label) => escapeRegex(label).replace(/\s+/g, '\\s+'))
    .join('|');
}

// A verdict LINE, not a mention. Tolerates a list bullet, a blockquote marker,
// bold markers, and a trailing period, because models decorate. This is what
// stops "I will end with VERDICT: PASS or VERDICT: FAIL" -- a sentence
// describing the format -- from being read as a real verdict.
function anchoredPattern(alternation) {
  return new RegExp(
    `^[ \\t>*_-]*(?:\\*\\*)?${MARKER}:\\s*(${alternation})(?:\\*\\*)?[ \\t.]*$`,
    'gim',
  );
}

function unanchoredPattern(alternation) {
  return new RegExp(`${MARKER}:\\s*(${alternation})\\b`, 'i');
}

function strippedPattern(alternation) {
  return new RegExp(
    `^[ \\t>*_-]*(?:\\*\\*)?${MARKER}:\\s*(?:${alternation}).*$`,
    'gim',
  );
}

function isPass(label, labels) {
  return label.trim().replace(/\s+/g, ' ').toUpperCase() === labels.pass;
}

function matchAnchored(visible, alternation, labels) {
  const found = [];
  for (const match of visible.matchAll(anchoredPattern(alternation))) {
    found.push(isPass(match[1], labels));
  }
  if (found.length === 0) {
    return { found: false };
  }
  const passes = found.filter(Boolean).length;
  if (passes === found.length) {
    return { found: true, passed: true, ambiguous: false };
  }
  if (passes === 0) {
    return { found: true, passed: false, ambiguous: false };
  }
  // Two anchored lines disagreeing is not something to guess at.
  return { found: true, passed: false, ambiguous: true };
}

function matchUnanchored(visible, alternation, labels) {
  const match = visible.match(unanchoredPattern(alternation));
  if (!match) {
    return { found: false };
  }
  return { found: true, passed: isPass(match[1], labels), ambiguous: false };
}

function feedbackFrom(visible, alternation) {
  const stripped = visible.replace(strippedPattern(alternation), '').trim();
  if (stripped) {
    return stripped;
  }
  // The reply was nothing but its verdict line. Hand back the whole thing
  // rather than an empty string -- a caller quoting this into a retry prompt
  // needs something to quote.
  return visible.trim();
}

/**
 * @typedef {object} ParsedVerdict
 * @property {boolean} passed - True only for an unambiguous positive verdict
 * @property {boolean} found - Whether any verdict marker was parsed at all
 * @property {boolean} ambiguous - Two anchored verdict lines disagreed
 * @property {string} feedback - The visible reply with verdict lines removed
 * @property {string} thinking - Chain-of-thought split out before parsing
 */

/**
 * Parse a model's final reply into a verdict. Fail-closed in every direction:
 * a missing, garbled, truncated, or self-contradicting marker parses as not
 * passed, so a broken reply is never read as success.
 *
 * The reply's chain-of-thought is removed before anything is matched. A
 * reasoning model talks itself through both answers on the way to one -- "so
 * the verdict: MET unless the tests are stubbed, let me check" -- and reading
 * a marker out of that scratchpad is reading a conclusion the model had not
 * reached yet.
 *
 * An anchored verdict line beats a mid-sentence mention. When there is no
 * anchored line at all the mention is accepted as a fallback, which keeps
 * replies that today's goal judge parses working exactly as they did.
 * @param {string} text
 * @param {{ pass: string, fail: string }} labels
 * @param {{ thinkTags?: string[] }} [options]
 * @returns {ParsedVerdict}
 */
export function parseVerdict(text, labels, options = {}) {
  const { visible, thinking } = splitThinking(text, options);
  const alternation = labelAlternation(labels);

  let matched = matchAnchored(visible, alternation, labels);
  if (!matched.found) {
    matched = matchUnanchored(visible, alternation, labels);
  }

  const feedback = feedbackFrom(visible, alternation);
  if (!matched.found) {
    return {
      passed: false,
      found: false,
      ambiguous: false,
      feedback,
      thinking,
    };
  }
  return {
    passed: matched.passed,
    found: true,
    ambiguous: matched.ambiguous,
    feedback,
    thinking,
  };
}
