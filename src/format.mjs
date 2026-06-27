/**
 * Terminal output formatting.
 * Renders tool calls, model responses, diagnostics, and results
 * in a compact, readable format for the terminal.
 */

import { hasContextHeadroom } from './model.mjs';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

/**
 * Format a tool call for terminal display (one compact line).
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {string}
 */
export function formatToolCall(name, args) {
  const summary = summariseArgs(name, args);
  return `${DIM}tool${RESET} ${CYAN}${name}${RESET} ${summary}`;
}

/**
 * Format a tool result for terminal display.
 * @param {string} name - Tool name
 * @param {object} result - Tool result
 * @returns {string}
 */
export function formatToolResult(name, result) {
  if (result.error) {
    return `${DIM}  -> ${RED}error:${RESET} ${result.error}`;
  }
  const preview = summariseResult(name, result);
  return `${DIM}  -> ${GREEN}ok${RESET} ${preview}`;
}

/**
 * Format a one-line notice (warnings, non-fatal diagnostics).
 * @param {string} text
 * @returns {string}
 */
export function formatNotice(text) {
  return `${YELLOW}note${RESET} ${text}`;
}

/**
 * Format verification result.
 * @param {{ passed: boolean, output: string, command: string }} result
 * @returns {string}
 */
export function formatVerification(result) {
  const icon = result.passed ? `${GREEN}pass${RESET}` : `${RED}fail${RESET}`;
  const lines = [
    `\n${BOLD}verify${RESET} ${icon} ${DIM}${result.command}${RESET}`,
  ];
  if (!result.passed && result.output) {
    const trimmed = result.output.slice(0, 2000);
    lines.push(trimmed);
  }
  return lines.join('\n');
}

/**
 * Format heal turn header.
 * @param {number} turn - Current turn number
 * @param {number} max - Maximum turns
 * @returns {string}
 */
export function formatHealTurn(turn, max) {
  return `\n${YELLOW}heal${RESET} turn ${turn}/${max}`;
}

/**
 * Format a run summary.
 * @param {object} result
 * @returns {string}
 */
export function formatSummary(result) {
  const lines = [`\n${BOLD}---${RESET}`];

  if (result.filesChanged && result.filesChanged.length > 0) {
    lines.push(`${DIM}files:${RESET} ${result.filesChanged.join(', ')}`);
  }

  if (result.verification) {
    const v = result.verification;
    const icon = v.passed ? `${GREEN}pass${RESET}` : `${RED}fail${RESET}`;
    lines.push(`${DIM}verify:${RESET} ${icon}`);
  }

  if (result.healed !== undefined) {
    lines.push(`${DIM}healed:${RESET} ${result.healed}`);
  }

  const tokens = result.usage;
  if (tokens) {
    lines.push(
      `${DIM}tokens:${RESET} ${tokens.prompt} in / ${tokens.completion} out`,
    );
  }

  return lines.join('\n');
}

/**
 * Format the model listing for `kodr models`: each model with its load state
 * and loaded/max context windows, flagging any loaded model that has unused
 * context headroom.
 * @param {Array} models - The `data` array from /api/v0/models
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function formatModelsList(models, baseUrl) {
  const url = baseUrl || 'http://localhost:1234/v1';
  if (!models || models.length === 0) {
    return `${formatNotice(`No models reported by ${url} — is LM Studio running with its /api/v0/models endpoint available?`)}`;
  }

  const lines = [`${BOLD}LM Studio models${RESET} ${DIM}${url}${RESET}`, ''];
  let anyHeadroom = false;

  for (const model of models) {
    const loaded = model.state === 'loaded';
    const dot = loaded ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    lines.push(`  ${dot} ${model.id}  ${modelContextSummary(model)}`);
    if (
      loaded &&
      hasContextHeadroom(model.loaded_context_length, model.max_context_length)
    ) {
      anyHeadroom = true;
    }
  }

  if (anyHeadroom) {
    lines.push('');
    lines.push(
      `${YELLOW}⚠${RESET} ${DIM}A loaded model below its max can be reloaded with a larger context length in LM Studio. A bigger window means longer sessions and fewer compactions, at the cost of more memory.${RESET}`,
    );
  }
  return lines.join('\n');
}

function modelContextSummary(model) {
  const max = Number.isInteger(model.max_context_length)
    ? model.max_context_length
    : null;

  if (
    model.state === 'loaded' &&
    Number.isInteger(model.loaded_context_length)
  ) {
    const loaded = model.loaded_context_length;
    let summary = `${DIM}loaded ${RESET}${loaded}${DIM} / ${max ?? '?'} max${RESET}`;
    if (hasContextHeadroom(loaded, max)) {
      summary += ` ${YELLOW}⚠ ${Math.floor(max / loaded)}× headroom${RESET}`;
    }
    return summary;
  }
  return `${DIM}${max ?? '?'} max${RESET}`;
}

// --- helpers ---

function summariseArgs(name, args) {
  if (!args) {
    return '';
  }
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    return DIM + (args.path || '') + RESET;
  }
  if (name === 'list_files') {
    return DIM + (args.path || '.') + RESET;
  }
  if (name === 'search') {
    return DIM + (args.pattern || '') + RESET;
  }
  if (name === 'run_command') {
    return DIM + (args.command || '') + RESET;
  }
  return DIM + JSON.stringify(args) + RESET;
}

function summariseResult(name, result) {
  if (name === 'read_file' && result.content) {
    const lines = result.content.split('\n').length;
    return `${DIM}${lines} lines${RESET}`;
  }
  if (name === 'list_files' && result.files) {
    return `${DIM}${result.files.length} entries${RESET}`;
  }
  if (name === 'write_file') {
    return `${DIM}written${RESET}`;
  }
  if (name === 'search' && result.matches) {
    return `${DIM}${result.matches.length} matches${RESET}`;
  }
  if (name === 'run_command') {
    const code = result.exitCode === 0 ? 'exit 0' : `exit ${result.exitCode}`;
    return DIM + code + RESET;
  }
  return '';
}
