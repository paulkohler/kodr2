/**
 * Split a reasoning model's chain-of-thought out of its visible reply.
 *
 * Local thinking models emit their scratchpad inline in the content field
 * wrapped in <think> tags, because LM Studio's OpenAI-compatible endpoint has
 * no reasoning field to put it in. Hosted providers use a field instead:
 * OpenRouter streams delta.reasoning, DeepSeek and vLLM use reasoning_content.
 * This module is the single place that knows what any of that looks like, so
 * the verdict parsers and the text-form tool-call recovery can share one
 * definition instead of each growing a regex (see specs/think.yaml).
 */

export const DEFAULT_THINK_TAGS = ['think', 'thinking'];

function cleanNames(values, separator) {
  const parts = [];
  for (const value of values) {
    for (const name of String(value).split(separator)) {
      const trimmed = name.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    }
  }
  return parts;
}

/**
 * Tag names treated as chain-of-thought wrappers. Resolved from an explicit
 * option, then KODR_THINK_TAGS (comma-separated), then the default -- so an
 * operator meeting a model with a novel wrapper adds it without a code change.
 * @param {string[]} [option]
 * @returns {string[]}
 */
export function thinkTagNames(option) {
  if (Array.isArray(option)) {
    const named = cleanNames(option, ',');
    if (named.length > 0) {
      return named;
    }
  }
  const fromEnv = process.env.KODR_THINK_TAGS;
  if (fromEnv) {
    const named = cleanNames([fromEnv], ',');
    if (named.length > 0) {
      return named;
    }
  }
  return DEFAULT_THINK_TAGS;
}

function tagAlternation(names) {
  return names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

// The opener must start a line. This repo carries the literal strings <think>
// and </think> in its own source, tests, and specs, and prompts/review.md asks
// the reviewer to quote what it found -- so a reply mentioning the tag
// mid-sentence must not open a block and swallow the rest of itself. Real
// models are unaffected: a chat template emits "<think>\n" at the very start
// of the turn, which is a line start.
function openerPattern(alternation) {
  return new RegExp(`^[ \\t]*<\\s*(?:${alternation})\\s*>`, 'im');
}

// Once an opener has been found the closer may sit anywhere -- the block is
// already bounded on the left, so the worst a stray mention can do is end the
// block early rather than discard the whole reply.
function closerPattern(alternation) {
  return new RegExp(`<\\s*/\\s*(?:${alternation})\\s*>`, 'i');
}

// A closer with no opener is the common LM Studio case: R1 and phi-4 chat
// templates pre-fill the opening tag into the prompt, so the model only ever
// emits the closer. Anchored to the end of a line because with no opener to
// bound it, a mid-sentence mention would discard everything before it.
function strayCloserPattern(alternation) {
  return new RegExp(`<\\s*/\\s*(?:${alternation})\\s*>[ \\t]*$`, 'im');
}

function splitOpenedBlocks(text, alternation) {
  const opener = openerPattern(alternation);
  const closer = closerPattern(alternation);
  const thinking = [];
  let visible = '';
  let rest = text;

  while (rest.length > 0) {
    const open = rest.match(opener);
    if (!open) {
      visible += rest;
      break;
    }
    visible += rest.slice(0, open.index);
    const afterOpen = rest.slice(open.index + open[0].length);
    const close = afterOpen.match(closer);
    if (!close) {
      // Unterminated -- a truncated reply. Everything after the opener is
      // scratchpad, and the visible part is whatever preceded it. Callers that
      // need a verdict then find none, which is the correct fail-closed read.
      thinking.push(afterOpen);
      break;
    }
    thinking.push(afterOpen.slice(0, close.index));
    rest = afterOpen.slice(close.index + close[0].length);
  }

  return { visible, thinking };
}

function splitStrayCloser(text, alternation) {
  const match = text.match(strayCloserPattern(alternation));
  if (!match) {
    return { visible: text, thinking: [] };
  }
  return {
    visible: text.slice(match.index + match[0].length),
    thinking: [text.slice(0, match.index)],
  };
}

function joinBlocks(blocks) {
  const kept = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed) {
      kept.push(trimmed);
    }
  }
  return kept.join('\n\n');
}

/**
 * @typedef {object} SplitText
 * @property {string} visible - The reply with every think block removed, trimmed
 * @property {string} thinking - The removed chain-of-thought, blocks joined by a
 *   blank line. Empty string when there was none -- never null, so callers can
 *   concatenate without guarding.
 */

/**
 * Split inline chain-of-thought out of a model reply. Never throws: a
 * non-string input returns empty strings rather than an error, because every
 * caller sits on a path where a throw would lose a reply that cost real time
 * to produce.
 * @param {string} text
 * @param {{ thinkTags?: string[] }} [options]
 * @returns {SplitText}
 */
export function splitThinking(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { visible: '', thinking: '' };
  }
  const alternation = tagAlternation(thinkTagNames(options.thinkTags));
  let split = splitOpenedBlocks(text, alternation);
  if (split.thinking.length === 0) {
    split = splitStrayCloser(text, alternation);
  }
  return {
    visible: split.visible.trim(),
    thinking: joinBlocks(split.thinking),
  };
}

/**
 * @typedef {object} SplitMessage
 * @property {string} content - The message's visible content
 * @property {string} thinking - reasoning_content, then reasoning, then any
 *   inline block, joined by blank lines
 */

/**
 * Split thinking out of a whole assistant message: the DeepSeek/vLLM
 * reasoning_content field, OpenRouter's reasoning field, and any inline think
 * block left in content.
 * @param {object} message
 * @param {{ thinkTags?: string[] }} [options]
 * @returns {SplitMessage}
 */
export function splitMessageThinking(message, options = {}) {
  if (!message || typeof message !== 'object') {
    return { content: '', thinking: '' };
  }
  const split = splitThinking(message.content, options);
  const blocks = [];
  if (typeof message.reasoning_content === 'string') {
    blocks.push(message.reasoning_content);
  }
  if (typeof message.reasoning === 'string') {
    blocks.push(message.reasoning);
  }
  if (split.thinking) {
    blocks.push(split.thinking);
  }
  return { content: split.visible, thinking: joinBlocks(blocks) };
}
