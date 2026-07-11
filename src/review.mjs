/**
 * Review pass -- a fresh tool-loop conversation over what the build phase
 * changed, with real (read-only) file access instead of a single pasted
 * diff and nothing else. Optionally runs on a separate review model (see
 * lms.mjs for the load/verify sequencing that makes that safe).
 */

import { loadPrompt } from './prompts.mjs';
import { createTerminalReporter } from './reporter.mjs';
import { runShell } from './shell.mjs';
import { runToolLoop } from './tool-loop.mjs';
import { createToolRegistry } from './tools/index.mjs';

const READ_ONLY_TOOLS = ['read_file', 'list_files', 'search'];

export const DEFAULT_MIN_REVIEW_TOOL_CALLS = 2;
export const DEFAULT_REVIEW_MAX_TOOL_TURNS = 12;
export const DEFAULT_REVIEW_DIFF_TIMEOUT_MS = 30_000;
const DEFAULT_DIFF_MAX_OUTPUT = 20_000;

/**
 * Timeout for the `git diff` call that gathers review context. Resolved
 * from an explicit option, then KODR_REVIEW_DIFF_TIMEOUT_MS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function reviewDiffTimeoutMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_REVIEW_DIFF_TIMEOUT_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_REVIEW_DIFF_TIMEOUT_MS;
}

/**
 * Tool-call floor before a review counts as grounded. Resolved from an
 * explicit option, then KODR_REVIEW_MIN_TOOL_CALLS, then the default; 0
 * disables the floor (and the retry it triggers).
 * @param {number} [option]
 * @returns {number}
 */
export function minReviewToolCalls(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_REVIEW_MIN_TOOL_CALLS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_MIN_REVIEW_TOOL_CALLS;
}

/**
 * Tool-turn ceiling for a single review attempt. Resolved from an explicit
 * option, then KODR_REVIEW_MAX_TOOL_TURNS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function reviewMaxToolTurns(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_REVIEW_MAX_TOOL_TURNS, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_REVIEW_MAX_TOOL_TURNS;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * A diff of the changed files, generated directly by the harness (not
 * exposed as a run_command call the model could make -- the review tool
 * set has no shell access at all). Empty, not an error, when git isn't
 * available or the workspace isn't a repo; the model still has
 * read_file/list_files/search to work from.
 */
async function gatherDiff(cwd, filesChanged, options = {}) {
  if (filesChanged.length === 0) {
    return '';
  }
  const run = options.run || runShell;
  const command = `git diff -- ${filesChanged.map(shQuote).join(' ')}`;
  const result = await run(command, cwd, {
    timeout: reviewDiffTimeoutMs(options.diffTimeoutMs),
    maxOutput: DEFAULT_DIFF_MAX_OUTPUT,
  });
  if (result.exitCode !== 0) {
    return '';
  }
  return result.stdout ?? '';
}

const REVIEW_SYSTEM = loadPrompt('review');
const REVIEW_NUDGE = loadPrompt('review-nudge');

function buildReviewMessages(filesChanged, diff, nudge) {
  const fileList = filesChanged.map((file) => `- ${file}`).join('\n');
  const diffSection = diff
    ? `\n\n<diff>\n${diff}\n</diff>`
    : '\n\n(No diff available -- read the files directly.)';
  const nudgeSection = nudge ? `\n\n${nudge}` : '';
  const user = `Files changed:\n${fileList}${diffSection}${nudgeSection}`;
  return [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: user },
  ];
}

async function runReviewAttempt(params) {
  const { messages, maxToolTurns, ...rest } = params;
  const loop = await runToolLoop({ ...rest, messages, maxToolTurns });
  return {
    findings: loop.finalText,
    toolTurns: loop.toolTurns,
    usage: loop.usage,
    retries: loop.retries || 0,
  };
}

/**
 * @typedef {object} ReviewResult
 * @property {boolean} skipped
 * @property {string} [findings]
 * @property {boolean} [grounded]
 * @property {number} [toolTurns]
 * @property {{ prompt: number, completion: number, cost: number }} [usage]
 * @property {number} [retries]
 * @property {string} [error]
 */

/**
 * Run a review pass. If the first attempt's tool-call count is under
 * minToolCalls, exactly one retry runs with an explicit nudge; if the
 * retry is still under the floor, grounded is false but the findings are
 * still returned -- never silently discarded.
 * @param {object} params
 * @param {import('./provider.mjs').Provider} params.client - Model client
 * @param {string} params.modelId - Review model to use
 * @param {string} params.cwd - Workspace root
 * @param {string[]} params.filesChanged - Files touched during the build phase
 * @param {Date} [params.startedAt]
 * @param {number} [params.maxRunMs] - Stop between turns after this many ms (0 disables)
 * @param {number} [params.contextWindow]
 * @param {number} [params.heartbeatMs]
 * @param {function} [params.onHeartbeat]
 * @param {function} [params.onDebug] - Forwarded to each attempt's tool loop (see specs/debug-log.yaml)
 * @param {string[]} [params.envPassthrough]
 * @param {number} [params.minToolCalls] - Tool-call floor before a review counts as grounded
 * @param {number} [params.maxToolTurns] - Tool-turn ceiling per attempt
 * @param {number} [params.diffTimeoutMs] - Timeout for the git diff call (default 30 seconds — KODR_REVIEW_DIFF_TIMEOUT_MS)
 * @param {import('./reporter.mjs').Reporter} [params.reporter] - Output channel; defaults to a terminal reporter (see comment below)
 * @returns {Promise<ReviewResult>}
 */
export async function runReview(params) {
  const {
    client,
    modelId,
    cwd,
    filesChanged = [],
    startedAt,
    maxRunMs = 0,
    contextWindow = 0,
    heartbeatMs,
    onHeartbeat,
    onDebug,
    envPassthrough = [],
    // The review pass has always streamed its inner tool loop straight to the
    // terminal, even under --quiet (runReview never forwarded quiet). Preserve
    // that exactly: default to a terminal reporter so the streaming is
    // unchanged, while runReviewPass's own notices honor the harness reporter.
    reporter = createTerminalReporter(),
  } = params;

  if (filesChanged.length === 0) {
    return { skipped: true };
  }

  const minToolCalls = minReviewToolCalls(params.minToolCalls);
  const maxToolTurns = reviewMaxToolTurns(params.maxToolTurns);
  const diff = await gatherDiff(cwd, filesChanged, params);
  const tools = createToolRegistry(cwd, {
    envPassthrough,
    startedAt,
    maxRunMs,
    allowedTools: READ_ONLY_TOOLS,
  });

  const loopParams = {
    client,
    modelId,
    tools,
    reporter,
    startedAt,
    maxRunMs,
    contextWindow,
    heartbeatMs,
    onHeartbeat,
    onDebug,
    maxToolTurns,
  };

  let attempt = await runReviewAttempt({
    ...loopParams,
    messages: buildReviewMessages(filesChanged, diff),
  });
  const totalUsage = { ...attempt.usage };
  let totalRetries = attempt.retries || 0;

  if (attempt.toolTurns < minToolCalls) {
    attempt = await runReviewAttempt({
      ...loopParams,
      messages: buildReviewMessages(filesChanged, diff, REVIEW_NUDGE),
    });
    totalUsage.prompt += attempt.usage.prompt;
    totalUsage.completion += attempt.usage.completion;
    totalUsage.cost += attempt.usage.cost || 0;
    totalRetries += attempt.retries || 0;
  }

  return {
    skipped: false,
    findings: attempt.findings,
    grounded: attempt.toolTurns >= minToolCalls,
    toolTurns: attempt.toolTurns,
    usage: totalUsage,
    retries: totalRetries,
  };
}
