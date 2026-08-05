import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_THINK_TAGS,
  splitMessageThinking,
  splitThinking,
  thinkTagNames,
} from '../src/think.mjs';

const ENV_KEYS = ['KODR_THINK_TAGS'];

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe('splitThinking', () => {
  it('returns the text unchanged as visible when there is no think block', () => {
    const split = splitThinking('The answer is 42.');
    assert.equal(split.visible, 'The answer is 42.');
    assert.equal(split.thinking, '');
  });

  it('removes a balanced think block and returns its contents as thinking', () => {
    const split = splitThinking(
      '<think>\nweighing it up\n</think>\nVERDICT: PASS',
    );
    assert.equal(split.visible, 'VERDICT: PASS');
    assert.equal(split.thinking, 'weighing it up');
  });

  it('handles several think blocks in one reply', () => {
    const split = splitThinking(
      '<think>\nfirst\n</think>\nA\n<think>\nsecond\n</think>\nB',
    );
    assert.equal(split.visible, 'A\n\nB');
    assert.equal(split.thinking, 'first\n\nsecond');
  });

  it('treats an unterminated think tag as thinking to the end, leaving what preceded it visible', () => {
    const split = splitThinking('Partial answer\n<think>\ncut off mid-thought');
    assert.equal(split.visible, 'Partial answer');
    assert.equal(split.thinking, 'cut off mid-thought');
  });

  it('treats a stray closing tag with no opener as the end of a block the chat template opened', () => {
    const split = splitThinking(
      'reasoning the template opened\n</think>\nVERDICT: FAIL',
    );
    assert.equal(split.visible, 'VERDICT: FAIL');
    assert.equal(split.thinking, 'reasoning the template opened');
  });

  it('matches the tag case-insensitively and tolerates whitespace inside the brackets', () => {
    const split = splitThinking('< THINK >\nhmm\n</ Think >\nDone');
    assert.equal(split.visible, 'Done');
    assert.equal(split.thinking, 'hmm');
  });

  it('leaves a mid-line think tag alone, so a reply quoting one does not corrupt its own split', () => {
    const quoted =
      'src/think.mjs matches <think> at a line start, and </think> at a line end.';
    const split = splitThinking(quoted);
    assert.equal(split.visible, quoted);
    assert.equal(split.thinking, '');
  });

  it('recognises the thinking tag as well as think', () => {
    const split = splitThinking('<thinking>\nscratch\n</thinking>\nOut');
    assert.equal(split.visible, 'Out');
    assert.equal(split.thinking, 'scratch');
  });

  it('returns empty visible and thinking for a non-string or empty input', () => {
    for (const input of [undefined, null, 42, {}, '']) {
      const split = splitThinking(input);
      assert.deepEqual(split, { visible: '', thinking: '' });
    }
  });
});

describe('thinkTagNames', () => {
  it('resolves the option, then KODR_THINK_TAGS, then the default', () => {
    assert.deepEqual(thinkTagNames(['reason']), ['reason']);

    process.env.KODR_THINK_TAGS = 'scratch, analysis';
    assert.deepEqual(thinkTagNames(undefined), ['scratch', 'analysis']);
    assert.deepEqual(thinkTagNames(['reason']), ['reason']);

    delete process.env.KODR_THINK_TAGS;
    assert.deepEqual(thinkTagNames(undefined), DEFAULT_THINK_TAGS);
  });

  it('ignores an empty option array and blank entries in the env var', () => {
    assert.deepEqual(thinkTagNames([]), DEFAULT_THINK_TAGS);
    assert.deepEqual(thinkTagNames(['  ']), DEFAULT_THINK_TAGS);

    process.env.KODR_THINK_TAGS = ' , scratch , ';
    assert.deepEqual(thinkTagNames(undefined), ['scratch']);
  });
});

describe('splitMessageThinking', () => {
  it('moves reasoning_content onto thinking and leaves content visible', () => {
    const split = splitMessageThinking({
      content: 'The answer',
      reasoning_content: 'deliberating',
    });
    assert.equal(split.content, 'The answer');
    assert.equal(split.thinking, 'deliberating');
  });

  it("moves OpenRouter's reasoning field onto thinking", () => {
    const split = splitMessageThinking({
      content: 'The answer',
      reasoning: 'deliberating',
    });
    assert.equal(split.content, 'The answer');
    assert.equal(split.thinking, 'deliberating');
  });

  it('combines a reasoning field and an inline block, the field first', () => {
    const split = splitMessageThinking({
      content: '<think>\ninline\n</think>\nThe answer',
      reasoning: 'streamed',
    });
    assert.equal(split.content, 'The answer');
    assert.equal(split.thinking, 'streamed\n\ninline');
  });

  it('leaves a message with no thinking untouched', () => {
    const split = splitMessageThinking({ content: 'Plain reply' });
    assert.deepEqual(split, { content: 'Plain reply', thinking: '' });
  });

  it('tolerates a message with no content', () => {
    assert.deepEqual(splitMessageThinking({}), { content: '', thinking: '' });
    assert.deepEqual(splitMessageThinking(null), { content: '', thinking: '' });
  });
});
