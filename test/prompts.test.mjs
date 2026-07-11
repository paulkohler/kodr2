import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadPrompt } from '../src/prompts.mjs';

// Every prompt file a consumer loads at module import. Loading one that is
// missing or empty throws, so this doubles as a packaging check.
const KNOWN_PROMPTS = [
  'system',
  'review',
  'review-nudge',
  'retrospective',
  'compact',
  'plan',
  'plan-step',
];

describe('loadPrompt', () => {
  it('every known prompt loads as non-empty trimmed text', () => {
    for (const name of KNOWN_PROMPTS) {
      const text = loadPrompt(name);
      assert.ok(text.length > 0, `${name} is empty`);
      assert.equal(text, text.trim(), `${name} is not trimmed`);
    }
  });

  it('throws on an unknown prompt name', () => {
    assert.throws(() => loadPrompt('no-such-prompt'), /prompt file missing/);
  });
});
