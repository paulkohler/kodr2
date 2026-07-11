/**
 * Terminal output formatting.
 * Renders tool calls, model responses, diagnostics, and results
 * in a compact, readable format for the terminal.
 */

import { hasContextHeadroom } from './model.mjs';

/** @typedef {import('./stats.mjs').Stats} Stats */

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
 * @param {{ error?: string, content?: string, files?: Array, matches?: Array, exitCode?: number, image?: { path: string } }} result - Tool result
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
 * Format a heartbeat notice for a long-running Stop hook, so a genuine long
 * wait (a slow test suite) is distinguishable from a stuck harness without
 * needing to inspect processes from outside.
 * @param {string} name - Hook name
 * @param {number} elapsedMs
 * @returns {string}
 */
export function formatHeartbeat(name, elapsedMs) {
  const seconds = Math.round(elapsedMs / 1000);
  return `${DIM}… ${name} still running (${seconds}s)${RESET}`;
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
 * Format the plan produced by the planning phase: a header plus one numbered
 * line per step title (descriptions stay in the run record).
 * @param {Array<{ id: number, title: string }>} steps
 * @param {boolean} [degraded] - True when planning failed and the single-step fallback is in use
 * @returns {string}
 */
export function formatPlan(steps, degraded) {
  const count = steps.length === 1 ? '1 step' : `${steps.length} steps`;
  const suffix = degraded
    ? ` ${YELLOW}(degraded to a single step)${RESET}`
    : '';
  const lines = [`\n${BOLD}plan${RESET} ${DIM}${count}${RESET}${suffix}`];
  for (const step of steps) {
    lines.push(`  ${DIM}${step.id}.${RESET} ${step.title}`);
  }
  return lines.join('\n');
}

/**
 * Format a plan-step transition (running/done/failed).
 * @param {{ id: number, total: number, title: string, status: string, stoppedReason?: string }} params
 * @returns {string}
 */
export function formatStepUpdate({ id, total, title, status, stoppedReason }) {
  const label = `${BOLD}step${RESET} ${id}/${total}`;
  if (status === 'running') {
    return `\n${label} ${CYAN}${title}${RESET}`;
  }
  if (status === 'done') {
    return `${label} ${GREEN}done${RESET}`;
  }
  const reason = stoppedReason ? ` ${DIM}(${stoppedReason})${RESET}` : '';
  return `${label} ${RED}failed${RESET}${reason}`;
}

/**
 * Format a run summary.
 * @param {{ filesChanged?: string[], verification?: { passed: boolean }, healed?: boolean, retries?: number, commits?: { raw?: object, fix?: object }, usage?: { prompt: number, completion: number, cost: number } }} result
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

  if (result.retries) {
    lines.push(`${DIM}retries:${RESET} ${result.retries}`);
  }

  if (result.commits) {
    lines.push(...formatCommitLines(result.commits));
  }

  const tokens = result.usage;
  if (tokens) {
    const costSuffix = tokens.cost ? ` (${formatCost(tokens.cost)})` : '';
    lines.push(
      `${DIM}tokens:${RESET} ${tokens.prompt} in / ${tokens.completion} out${costSuffix}`,
    );
  }

  return lines.join('\n');
}

/**
 * Format a USD cost value (OpenRouter's usage.cost; always 0 for a local
 * backend like LM Studio, which has none). Four decimal places -- a single
 * turn is commonly a fraction of a cent, and rounding to 2dp would show
 * "$0.00" for real, nonzero spend.
 * @param {number} cost
 * @returns {string}
 */
export function formatCost(cost) {
  return `$${cost.toFixed(4)}`;
}

/**
 * Lines for raw-then-fix commit mode's result -- a rejected hook or a
 * failed `git add`/`git commit` is actionable and must not be silently
 * absorbed into the result object with no visible signal. A clean skip
 * (no files changed, nothing to commit) stays quiet.
 * @param {{ raw?: { committed?: boolean, sha?: string, error?: string }, fix?: { committed?: boolean, sha?: string, error?: string } }} commits
 * @returns {string[]}
 */
function formatCommitLines(commits) {
  const lines = [];
  for (const [label, commit] of Object.entries(commits)) {
    if (!commit) {
      continue;
    }
    if (commit.committed) {
      lines.push(
        `${DIM}commit (${label}):${RESET} ${GREEN}${commit.sha.slice(0, 8)}${RESET}`,
      );
    } else if (commit.error) {
      lines.push(
        `${DIM}commit (${label}):${RESET} ${RED}failed${RESET} ${commit.error}`,
      );
    }
  }
  return lines;
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

/**
 * Format the model listing for `kodr models` on a provider with no
 * richModels/context-probing capability (e.g. OpenRouter) -- just the
 * model ids, no load state or context window (nothing to report).
 * @param {Array<{ id: string }>} models
 * @param {string} providerName
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function formatSimpleModelsList(models, providerName, baseUrl) {
  const url = baseUrl || '';
  if (!models || models.length === 0) {
    return `${formatNotice(`No models reported by ${providerName}${url ? ` at ${url}` : ''}.`)}`;
  }

  const lines = [
    `${BOLD}${providerName} models${RESET}${url ? ` ${DIM}${url}${RESET}` : ''}`,
    '',
  ];
  for (const model of models) {
    lines.push(`  ${DIM}○${RESET} ${model.id}`);
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

/**
 * Format a `kodr doctor` report.
 * @param {{ checks: Array<{ name: string, status: string, detail: string }>, ok: boolean }} report
 * @returns {string}
 */
export function formatDoctorReport(report) {
  const lines = [`${BOLD}kodr doctor${RESET}`, ''];
  for (const check of report.checks) {
    lines.push(
      `  ${statusIcon(check.status)} ${check.name}${DIM} -- ${check.detail}${RESET}`,
    );
  }
  lines.push('');
  lines.push(
    report.ok
      ? `${GREEN}ok${RESET}`
      : `${RED}failed -- see the checks above${RESET}`,
  );
  return lines.join('\n');
}

function statusIcon(status) {
  if (status === 'ok') {
    return `${GREEN}✓${RESET}`;
  }
  if (status === 'warn') {
    return `${YELLOW}⚠${RESET}`;
  }
  return `${RED}✗${RESET}`;
}

/**
 * Format a `kodr stats` report.
 * @param {Stats} stats
 * @returns {string}
 */
export function formatStats(stats) {
  if (stats.total === 0) {
    return formatNotice('No run records found.');
  }

  const lines = [
    `${BOLD}kodr stats${RESET} ${DIM}${stats.total} runs${RESET}`,
    '',
  ];

  const reasons = Object.entries(stats.stoppedReasonCounts)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
  lines.push(`  ${DIM}stopped reasons:${RESET} ${reasons}`);
  lines.push(`  ${DIM}no-op completions:${RESET} ${pct(stats.noOpRate)}`);
  lines.push(
    `  ${DIM}heal attempted:${RESET} ${pct(stats.healAttemptedRate)}${DIM}  succeeded:${RESET} ${pctOrNA(stats.healSuccessRate)}`,
  );
  lines.push(
    `  ${DIM}compaction rate:${RESET} ${pct(stats.compactionRate)}${DIM}  avg per run:${RESET} ${stats.avgCompactions.toFixed(2)}`,
  );
  lines.push(
    `  ${DIM}retry rate:${RESET} ${pct(stats.retryRate)}${DIM}  avg per run:${RESET} ${stats.avgRetries.toFixed(2)}`,
  );
  lines.push(
    `  ${DIM}verify attempted:${RESET} ${pct(stats.verifyAttemptedRate)}${DIM}  passed:${RESET} ${pctOrNA(stats.verifyPassRate)}`,
  );
  lines.push(
    `  ${DIM}avg tool turns:${RESET} ${stats.avgToolTurns.toFixed(1)}`,
  );
  lines.push(
    `  ${DIM}avg duration:${RESET} ${stats.avgDurationMs === null ? 'n/a' : `${Math.round(stats.avgDurationMs)}ms`}`,
  );
  const totalCostSuffix = stats.totalUsage.cost
    ? ` (${formatCost(stats.totalUsage.cost)})`
    : '';
  lines.push(
    `  ${DIM}total tokens:${RESET} ${stats.totalUsage.prompt} in / ${stats.totalUsage.completion} out${totalCostSuffix}`,
  );

  return lines.join('\n');
}

function pct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function pctOrNA(fraction) {
  return fraction === null ? 'n/a' : pct(fraction);
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
    const scope = [args.path, args.glob].filter(Boolean).join(' ');
    const text = scope
      ? `${args.pattern || ''} (${scope})`
      : args.pattern || '';
    return DIM + text + RESET;
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
  if (name === 'view_image' && result.image) {
    return `${DIM}viewing ${result.image.path}${RESET}`;
  }
  return '';
}
