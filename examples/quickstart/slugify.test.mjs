import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from './slugify.mjs';

test('lowercases a simple title', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses spaces, tabs, and newlines into one separator', () => {
  assert.equal(slugify('One  Two\tThree\nFour'), 'one-two-three-four');
});

test('treats punctuation as a separator and trims the edges', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
});

test('collapses repeated hyphens and preserves digits', () => {
  assert.equal(slugify('Release---2.0'), 'release-2-0');
});

test('keeps an existing slug unchanged', () => {
  assert.equal(slugify('already-a-slug-42'), 'already-a-slug-42');
});

test('returns an empty slug for empty or punctuation-only input', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('  !!!  '), '');
});
