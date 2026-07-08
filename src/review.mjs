/**
 * Review pass -- a fresh tool-loop conversation over what the build phase
 * changed, with real (read-only) file access instead of a single pasted
 * diff and nothing else. Optionally runs on a separate review model (see
 * lms.mjs for the load/verify sequencing that makes that safe).
 */

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

function buildReviewMessages(filesChanged, diff, nudge) {
  const fileList = filesChanged.map((file) => `- ${file}`).join('\n');
  const diffSection = diff
    ? `\n\n<diff>\n${diff}\n</diff>`
    : '\n\n(No diff available -- read the files directly.)';
  const nudgeSection = nudge ? `\n\n${nudge}` : '';
  const system =
    'You are reviewing a code change for correctness, not style. You have ' +
    'read-only tools (read_file, list_files, search) -- use them to check ' +
    'imports, call sites, and related tests before drawing conclusions. Do ' +
    'not just react to the diff text below without verifying it against ' +
    'the real files; a diff without checked context is exactly how past ' +
    'reviews got fooled. Respond with a short list of concrete findings ' +
    '(file, line if known, and what\'s wrong), or "No findings." if ' +
    'nothing stood out. Never cite a file, quote, or line you have not ' +
    'actually read via a tool call.';
  const user = `Files changed:\n${fileList}${diffSection}${nudgeSection}`;
  return [
    { role: 'system', content: system },
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
 * Run a review pass. If the first attempt's tool-call count is under
 * minToolCalls, exactly one retry runs with an explicit nudge; if the
 * retry is still under the floor, grounded is false but the findings are
 * still returned -- never silently discarded.
 * @param {object} params
 * @param {object} params.client - Model client
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
 * @returns {Promise<{ skipped: boolean, findings?: string, grounded?: boolean, toolTurns?: number, usage?: object, retries?: number }>}
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
    const nudge =
      'Read the actual changed files with the tools provided before ' +
      'answering -- do not answer from the diff text alone. A review ' +
      'that never opened a file has no business citing a file:line.';
    attempt = await runReviewAttempt({
      ...loopParams,
      messages: buildReviewMessages(filesChanged, diff, nudge),
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
