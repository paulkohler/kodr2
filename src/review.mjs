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
import { parseVerdict, REVIEW_LABELS } from './verdict.mjs';

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
const REVIEW_VERDICT_NUDGE = loadPrompt('review-verdict-nudge');
const REVIEW_RETRY = loadPrompt('review-retry');
const REVIEW_RETRY_UNGROUNDED = loadPrompt('review-retry-ungrounded');

/**
 * Frame a failed review for the builder's next attempt: the reviewer's
 * findings, plus the original task restated so the model still knows what it
 * was asked for. Paired with the continuation the loop already replays
 * (priorMessages/priorFilesChanged) this is the same shape as `--continue`
 * with a follow-up, and the sibling of goal.mjs's buildRetryPrompt.
 * @param {string} task
 * @param {ReviewResult} review
 * @returns {string}
 */
export function buildReviewRetryPrompt(task, review) {
  const findings = review?.findings?.trim();
  if (!findings) {
    return `${REVIEW_RETRY_UNGROUNDED}\nTask:\n${task}`;
  }
  return `${REVIEW_RETRY}\nReview findings:\n${findings}\n\nTask:\n${task}`;
}

/**
 * Whether a blocking review verdict should fail the process or block a commit.
 * Resolved from an explicit option, then KODR_FAIL_ON_REVIEW, then false --
 * the review pass has always been advisory and stays that way unless asked.
 *
 * Note this defaults to false rather than null: the resolver checks for an
 * explicit `true` first, so the env var is still reachable. It must become
 * null the day a --no-fail-on-review exists, since then false would have to
 * mean "explicitly off, beat the env var".
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function failOnReviewEnabled(option) {
  if (option === true) {
    return true;
  }
  const fromEnv = process.env.KODR_FAIL_ON_REVIEW;
  return fromEnv === '1' || fromEnv === 'true';
}

/**
 * Whether Kodr should swap models on the local backend around the review
 * pass. On by default: with one LM Studio serving both roles, the reviewer
 * cannot run until it is loaded, and Kodr owning that sequencing is the whole
 * point of specs/lms.yaml.
 *
 * Turn it off when the reviewer lives somewhere the build model isn't
 * competing with it -- a second LM Studio port, Ollama, OpenRouter. The swap
 * costs two full model loads per attempt (ensureModelLoaded unloads
 * everything first, and run() reloads the build model on the next attempt),
 * which over a checklist of tasks at several attempts each is the dominant
 * cost of the run.
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function reviewSwapEnabled(option) {
  if (option === true) {
    return true;
  }
  if (option === false) {
    return false;
  }
  const fromEnv = process.env.KODR_REVIEW_SWAP;
  if (fromEnv === '0' || fromEnv === 'false') {
    return false;
  }
  return true;
}

/**
 * Provider name for the review pass, or null to reuse the build's.
 * @param {string} [option]
 * @returns {string|null}
 */
export function reviewProviderName(option) {
  return option || process.env.KODR_REVIEW_PROVIDER || null;
}

/**
 * Base URL for the review pass, or null to reuse the build's.
 * @param {string} [option]
 * @returns {string|null}
 */
export function reviewBaseUrlFor(option) {
  return option || process.env.KODR_REVIEW_BASE_URL || null;
}

/**
 * Where the review pass should send its requests. A review provider brings
 * its own default base URL -- carrying the build's over would point, say,
 * Ollama at LM Studio's port -- while a review base URL alone just moves the
 * build's provider to a different endpoint.
 * @param {{ reviewProvider?: string, reviewBaseUrl?: string,
 *   buildProvider?: string, buildBaseUrl?: string }} params
 * @returns {{ provider: string|undefined, baseUrl: string|undefined }}
 */
export function reviewEndpoint(params) {
  const { reviewProvider, reviewBaseUrl, buildProvider, buildBaseUrl } = params;
  if (reviewProvider) {
    return { provider: reviewProvider, baseUrl: reviewBaseUrl };
  }
  return { provider: buildProvider, baseUrl: reviewBaseUrl || buildBaseUrl };
}

/**
 * Parse a reviewer's reply into a verdict and the findings text. The reviewer
 * must end with an explicit `VERDICT: PASS` or `VERDICT: FAIL` line; a
 * missing, garbled, contradictory, or think-block-only verdict parses as fail,
 * so a reply nobody can read never waves a change through.
 * @param {string} text
 * @returns {{ verdict: 'pass'|'fail', verdictFound: boolean, findings: string }}
 */
export function parseReviewVerdict(text) {
  const parsed = parseVerdict(text, REVIEW_LABELS);
  if (parsed.passed) {
    return { verdict: 'pass', verdictFound: true, findings: parsed.feedback };
  }
  return {
    verdict: 'fail',
    verdictFound: parsed.found,
    findings: parsed.feedback,
  };
}

/**
 * Whether a review result should block -- fail the process, or stop a loop
 * committing the change.
 *
 * A skipped review never blocks. There was no assessment, and "no assessment"
 * must not read as a failed one: that covers an empty changeset, a build that
 * never completed, a failed model switch, and a reviewer that crashed. A
 * crashed reviewer parking a task is the worst possible failure mode for an
 * unattended loop.
 *
 * An ungrounded pass does not block either. It is recorded and surfaced
 * (reviewGroundedRate in kodr stats) but treated as advisory: a small local
 * reviewer being lazy on a trivial diff should not park work that is fine,
 * and parking good work overnight is the expensive direction to fail in.
 * @param {ReviewResult} [review]
 * @returns {boolean}
 */
export function reviewBlocks(review) {
  if (!review) {
    return false;
  }
  if (review.skipped) {
    return false;
  }
  return review.verdict === 'fail';
}

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
  const parsed = parseReviewVerdict(loop.finalText);
  return {
    findings: parsed.findings,
    verdict: parsed.verdict,
    verdictFound: parsed.verdictFound,
    stoppedReason: loop.stoppedReason,
    toolTurns: loop.toolTurns,
    usage: loop.usage,
    retries: loop.retries || 0,
  };
}

// A review that ran out of road produced no assessment, and "no assessment"
// must never read as a failed one -- the same rule that keeps a crashed
// reviewer from parking a task. Without this, a reviewer cut off by the run's
// budget hands back empty text, which parses fail-closed into VERDICT: FAIL
// and, under --fail-on-review, blocks a commit whose code was fine and whose
// tests passed. Caught live: a reasoning model spent the run's whole remaining
// budget thinking, and the build it had nothing to say about was failed.
//
// Usage is carried through even though nothing was decided -- those tokens
// were really spent, and dropping them would understate the run's cost.
function reviewCutOff(stoppedReason, usage, retries) {
  return {
    skipped: true,
    reason: `review did not complete (stoppedReason: ${stoppedReason})`,
    usage,
    retries,
  };
}

// One nudge covers both ways an attempt can fall short, and an attempt can
// fall short both ways at once -- so the fragments are joined rather than
// chosen between. Telling a grounded reviewer to go read files would be noise.
function nudgeFor(attempt, minToolCalls) {
  const parts = [];
  if (attempt.toolTurns < minToolCalls) {
    parts.push(REVIEW_NUDGE);
  }
  if (!attempt.verdictFound) {
    parts.push(REVIEW_VERDICT_NUDGE);
  }
  return parts.join('\n\n');
}

/**
 * @typedef {object} ReviewResult
 * @property {boolean} skipped
 * @property {string} [findings]
 * @property {'pass'|'fail'} [verdict] - What the reviewer said. Absent when skipped
 * @property {boolean} [verdictFound] - False when no verdict line could be
 *   parsed; verdict is then 'fail', fail-closed
 * @property {boolean} [passed] - The harness's decision. Diverges from verdict
 *   only in that an unparseable reply reads as fail
 * @property {boolean} [grounded]
 * @property {number} [toolTurns]
 * @property {{ prompt: number, completion: number, cost: number }} [usage]
 * @property {number} [retries]
 * @property {string} [error]
 * @property {string} [reason] - Why a skipped review was skipped, on the paths
 *   that know (e.g. the build never completed)
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
 * @param {AbortSignal} [params.signal] - Cancellation signal (see specs/cancel.yaml),
 *   forwarded to every attempt's tool loop. Without it a review pass is
 *   unstoppable: a reasoning model has spent 20 minutes on a single pass.
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
    signal,
    // The review pass has always streamed its inner tool loop to the terminal
    // even under --quiet (runReview never forwarded quiet), and that stays
    // true -- but it streams to stderr, not stdout. A terminal reporter sends
    // model text to stdout, which under --json is the data channel: the review
    // stream landed in front of the JSON document and made it unparseable.
    // Caught live, dogfooding --review-model with --json.
    reporter = createTerminalReporter({
      stdout: process.stderr,
      stderr: process.stderr,
    }),
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
    // A cancelled attempt comes back stoppedReason "cancelled", which
    // reviewCutOff below turns into a skip -- never a FAIL verdict. Aborting
    // a review must not be able to block a commit.
    signal,
  };

  let attempt = await runReviewAttempt({
    ...loopParams,
    messages: buildReviewMessages(filesChanged, diff),
  });
  const totalUsage = { ...attempt.usage };
  let totalRetries = attempt.retries || 0;

  if (attempt.stoppedReason !== 'complete') {
    // No nudge retry here: whatever ran the first attempt out of budget or
    // tool turns will do the same to a second, only slower.
    return reviewCutOff(attempt.stoppedReason, totalUsage, totalRetries);
  }

  const nudge = nudgeFor(attempt, minToolCalls);
  if (nudge) {
    attempt = await runReviewAttempt({
      ...loopParams,
      messages: buildReviewMessages(filesChanged, diff, nudge),
    });
    totalUsage.prompt += attempt.usage.prompt;
    totalUsage.completion += attempt.usage.completion;
    totalUsage.cost += attempt.usage.cost || 0;
    totalRetries += attempt.retries || 0;
    if (attempt.stoppedReason !== 'complete') {
      return reviewCutOff(attempt.stoppedReason, totalUsage, totalRetries);
    }
  }

  return {
    skipped: false,
    findings: attempt.findings,
    verdict: attempt.verdict,
    verdictFound: attempt.verdictFound,
    // What the reviewer said vs. what the harness decided. They only diverge
    // on an unparseable reply, but keeping both is what lets kodr stats tell
    // "the reviewer never emits a verdict line" apart from "the reviewer keeps
    // failing us" -- different problems, different fixes.
    passed: attempt.verdict === 'pass',
    grounded: attempt.toolTurns >= minToolCalls,
    toolTurns: attempt.toolTurns,
    usage: totalUsage,
    retries: totalRetries,
  };
}
