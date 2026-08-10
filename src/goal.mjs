/**
 * kodr goal -- the evaluator loop (specs/goal.yaml). Iterate run() until a
 * model judge confirms a natural-language goal is met, or a cap (max attempts)
 * is hit. The outer loop the harness otherwise leaves to a shell script
 * (examples/loop.sh), but with a fuzzy stop condition a test command can't
 * express, judged by a model instead of an exit code.
 *
 * runGoal is pure orchestration: it takes the per-attempt build (runTask) and
 * the judge (evaluate) as injected callbacks, so the loop control is unit-tested
 * without a model. evaluateGoal is the model-backed judge -- a read-only,
 * grounded tool loop borrowing the review pass's anti-hallucination stance.
 */

import { loadPrompt } from './prompts.mjs';
import { createNullReporter } from './reporter.mjs';
import { reviewBlocks } from './review.mjs';
import { runCancelled, runToolLoop } from './tool-loop.mjs';
import { createToolRegistry } from './tools/index.mjs';
import {
  GOAL_LABELS,
  parseVerdict as parseLabelledVerdict,
} from './verdict.mjs';

const READ_ONLY_TOOLS = ['read_file', 'list_files', 'search'];

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_JUDGE_MIN_TOOL_CALLS = 1;
export const DEFAULT_JUDGE_MAX_TOOL_TURNS = 12;

const JUDGE_SYSTEM = loadPrompt('goal-judge');

/**
 * Cap on build+judge iterations. Resolved from an explicit option, then
 * KODR_GOAL_MAX_ATTEMPTS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function goalMaxAttempts(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_GOAL_MAX_ATTEMPTS, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_MAX_ATTEMPTS;
}

/**
 * Tool-call floor before a judge verdict is trusted as grounded. Resolved from
 * an explicit option, then KODR_GOAL_JUDGE_MIN_TOOL_CALLS, then the default; 0
 * disables the floor.
 * @param {number} [option]
 * @returns {number}
 */
export function judgeMinToolCalls(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(
    process.env.KODR_GOAL_JUDGE_MIN_TOOL_CALLS,
    10,
  );
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_JUDGE_MIN_TOOL_CALLS;
}

/**
 * Tool-turn ceiling for a single judge assessment. Resolved from an explicit
 * option, then KODR_GOAL_JUDGE_MAX_TOOL_TURNS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function judgeMaxToolTurns(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(
    process.env.KODR_GOAL_JUDGE_MAX_TOOL_TURNS,
    10,
  );
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_JUDGE_MAX_TOOL_TURNS;
}

/**
 * Parse a judge's final reply into a verdict. The judge must end with an
 * explicit `VERDICT: MET` or `VERDICT: NOT MET` line; a missing, garbled, or
 * truncated marker parses as not met, so a broken reply is never read as
 * success. Feedback is the reply text with the verdict line removed.
 *
 * The parsing itself lives in verdict.mjs, shared with the review pass -- this
 * keeps the { met, feedback } shape the judge's callers expect.
 * @param {string} text
 * @returns {{ met: boolean, feedback: string }}
 */
export function parseVerdict(text) {
  const parsed = parseLabelledVerdict(text, GOAL_LABELS);
  return { met: parsed.passed, feedback: parsed.feedback };
}

/**
 * @typedef {object} Verdict
 * @property {boolean} met
 * @property {boolean} grounded
 * @property {string} feedback
 * @property {number} toolTurns
 * @property {{ prompt: number, completion: number, cost: number }} usage
 * @property {number} retries
 * @property {string} [source] - "judge" (the default, implied when absent) or
 *   "review" for a verdict synthesized from a blocking review verdict
 */

/**
 * Wrap a judge so a blocking review short-circuits it: an attempt the reviewer
 * failed is not met regardless of what the judge would say, and spending a
 * judge call -- plus, on one LM Studio, a model swap -- to be told so is
 * waste.
 *
 * The synthesized verdict carries the reviewer's findings as its feedback, so
 * runGoal's existing buildRetryPrompt hands them to the next attempt with no
 * change to the loop itself. runGoal is not modified; loop control stays pure.
 * @param {(result: import('./harness.mjs').RunResult, attempt: number) => Promise<Verdict>} evaluate
 * @param {boolean} failOnReview
 * @returns {(result: import('./harness.mjs').RunResult, attempt: number) => Promise<Verdict>}
 */
export function withReviewGate(evaluate, failOnReview) {
  if (!failOnReview) {
    return evaluate;
  }
  return async (result, attempt) => {
    if (!reviewBlocks(result?.review)) {
      return evaluate(result, attempt);
    }
    return {
      met: false,
      // Grounded in the sense that matters here: this verdict rests on a
      // review that actually happened, so runGoal should act on it rather
      // than treat it as an unreliable judge reply and continue.
      grounded: true,
      feedback: reviewFeedback(result.review),
      toolTurns: 0,
      usage: { prompt: 0, completion: 0, cost: 0 },
      retries: 0,
      source: 'review',
    };
  };
}

// buildRetryPrompt frames its feedback as "Assessment from the judge". These
// words are the reviewer's, so say so rather than let the next attempt be
// told the judge found something the judge never looked at.
function reviewFeedback(review) {
  const findings = review?.findings?.trim();
  if (!findings) {
    return 'A separate review model inspected the change and did not pass it, but produced no usable findings.';
  }
  return `A separate review model inspected the change and did not pass it:\n${findings}`;
}

function buildJudgeMessages(goal, filesChanged) {
  const fileList =
    filesChanged.length > 0
      ? filesChanged.map((file) => `- ${file}`).join('\n')
      : '(no files were changed this attempt)';
  const user = `Goal:\n${goal}\n\nFiles changed so far:\n${fileList}\n\nAssess whether the goal is met. Investigate with your read-only tools before deciding, then end with a VERDICT line.`;
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: user },
  ];
}

/**
 * Run one judge assessment: a read-only tool loop over the workspace that ends
 * with a VERDICT line. A verdict reached in fewer than minToolCalls tool calls
 * is marked ungrounded (but still returned) -- the caller decides not to trust
 * an ungrounded "met" to stop the loop.
 * @param {object} params
 * @param {import('./provider.mjs').Provider} params.client
 * @param {string} params.modelId
 * @param {string} params.cwd
 * @param {string} params.goal
 * @param {string[]} [params.filesChanged]
 * @param {Date} [params.startedAt]
 * @param {number} [params.maxRunMs]
 * @param {number} [params.contextWindow]
 * @param {number} [params.heartbeatMs]
 * @param {function} [params.onHeartbeat]
 * @param {function} [params.onDebug]
 * @param {string[]} [params.envPassthrough]
 * @param {number} [params.minToolCalls]
 * @param {number} [params.maxToolTurns]
 * @param {AbortSignal} [params.signal] - Cancellation signal (see specs/cancel.yaml),
 *   forwarded to the judge's tool loop. The judge is a full read-only tool loop
 *   plus a verdict call, so without it a Ctrl-C cannot stop the judge phase.
 * @param {import('./reporter.mjs').Reporter} [params.reporter]
 * @returns {Promise<Verdict>}
 */
export async function evaluateGoal(params) {
  const {
    client,
    modelId,
    cwd,
    goal,
    filesChanged = [],
    // The judge's own budget clock starts when it does. Defaulted here so a
    // caller can omit it: with maxRunMs set, the tool loop's budget check calls
    // startedAt.getTime(), which throws on undefined (caught live with a
    // --max-run-ms goal run; the unit tests ran with the budget disabled).
    startedAt = new Date(),
    maxRunMs = 0,
    contextWindow = 0,
    heartbeatMs,
    onHeartbeat,
    onDebug,
    envPassthrough = [],
    signal,
    reporter = createNullReporter(),
  } = params;

  const minToolCalls = judgeMinToolCalls(params.minToolCalls);
  const maxToolTurns = judgeMaxToolTurns(params.maxToolTurns);
  const tools = createToolRegistry(cwd, {
    envPassthrough,
    startedAt,
    maxRunMs,
    allowedTools: READ_ONLY_TOOLS,
  });

  const loop = await runToolLoop({
    client,
    modelId,
    tools,
    messages: buildJudgeMessages(goal, filesChanged),
    reporter,
    startedAt,
    maxRunMs,
    contextWindow,
    heartbeatMs,
    onHeartbeat,
    onDebug,
    maxToolTurns,
    signal,
  });

  const parsed = parseVerdict(loop.finalText);
  return {
    met: parsed.met,
    grounded: loop.toolTurns >= minToolCalls,
    feedback: parsed.feedback,
    toolTurns: loop.toolTurns,
    usage: loop.usage,
    retries: loop.retries || 0,
  };
}

/**
 * Frame a not-yet-met goal for the next attempt: the prior judge's feedback plus
 * the goal restated. Paired with priorMessages/priorFilesChanged, this is the
 * same continuation the CLI's --continue uses.
 * @param {string} goal
 * @param {string} feedback
 * @returns {string}
 */
export function buildRetryPrompt(goal, feedback) {
  let why = '\n\nThe goal is not yet met.';
  if (feedback) {
    why = `\n\nThe goal is not yet met. Assessment from the judge:\n${feedback}`;
  }
  return `Continue working toward this goal.${why}\n\nGoal:\n${goal}`;
}

function addUsage(total, usage) {
  if (!usage) {
    return;
  }
  total.prompt += usage.prompt || 0;
  total.completion += usage.completion || 0;
  total.cost += usage.cost || 0;
}

/**
 * @typedef {object} GoalResult
 * @property {boolean} met
 * @property {string} reason - "met" | "exhausted" | "stalled" | "build-error" | "judge-error" | "cancelled"
 * @property {number} attempts
 * @property {Verdict[]} verdicts
 * @property {import('./harness.mjs').RunResult|null} lastResult
 * @property {{ prompt: number, completion: number, cost: number }} usage
 * @property {number} retries
 * @property {{ message: string, name?: string, stack?: string }} [judgeError]
 */

/**
 * The evaluator loop. Pure orchestration over two injected collaborators:
 * runTask(prompt, continuation) builds one attempt and returns its RunResult;
 * evaluate(result, attempt) judges it and returns a Verdict. The loop stops on
 * the first met-and-grounded verdict, the attempt cap, a two-attempt no-change
 * stall, a build error, or a judge error.
 *
 * A build error already comes back as a returned value (RunResult's
 * stoppedReason: 'error') rather than a throw -- runTask goes through
 * harness.mjs's run(), which converts a thrown tool-loop error into that
 * shape. evaluate() has no such wrapper (evaluateGoal calls runToolLoop
 * directly), so a judge-side failure -- the same kind of thing run() already
 * guards against, e.g. a backend crashing mid-request -- is caught here
 * instead. Without this, that failure would propagate out of runGoal
 * entirely and discard a build that had just succeeded.
 * @param {object} params
 * @param {string} params.goal
 * @param {(prompt: string, continuation: ({ priorMessages: Array, priorFilesChanged: string[] }|null)) => Promise<import('./harness.mjs').RunResult>} params.runTask
 * @param {(result: import('./harness.mjs').RunResult, attempt: number) => Promise<Verdict>} params.evaluate
 * @param {number} [params.maxAttempts]
 * @param {AbortSignal} [params.signal] - Cancellation signal (see specs/cancel.yaml).
 *   Checked at the top of each attempt and again after the build, so one Ctrl-C
 *   ends the goal instead of being absorbed by a single attempt.
 * @param {import('./reporter.mjs').Reporter} [params.reporter]
 * @returns {Promise<GoalResult>}
 */
export async function runGoal(params) {
  const { goal, runTask, evaluate, signal } = params;
  const reporter = params.reporter || createNullReporter();
  const maxAttempts = goalMaxAttempts(params.maxAttempts);

  const verdicts = [];
  const usage = { prompt: 0, completion: 0, cost: 0 };
  let retries = 0;
  let lastResult = null;
  let continuation = null;
  let noChangeStreak = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // A cancel is terminal for the whole goal, not just the attempt that saw
    // it. Without these two checks one Ctrl-C still paid for the judge on the
    // aborted attempt (a full read-only tool loop) and then started every
    // remaining attempt -- the cancellation bug, multiplied by maxAttempts.
    if (signal?.aborted) {
      reporter.notice('goal stopped: cancelled');
      return finish(
        false,
        'cancelled',
        attempt - 1,
        verdicts,
        lastResult,
        usage,
        retries,
      );
    }

    reporter.phase(`goal attempt ${attempt}/${maxAttempts}`);

    let prompt = goal;
    if (attempt > 1) {
      prompt = buildRetryPrompt(goal, verdicts[verdicts.length - 1].feedback);
    }

    const result = await runTask(prompt, continuation);
    lastResult = result;
    addUsage(usage, result.usage);
    retries += result.retries || 0;

    if (runCancelled(signal, result.stoppedReason)) {
      reporter.notice('goal stopped: cancelled');
      return finish(
        false,
        'cancelled',
        attempt,
        verdicts,
        lastResult,
        usage,
        retries,
      );
    }

    if (result.stoppedReason === 'error') {
      reporter.notice('goal stopped: build error');
      return finish(
        false,
        'build-error',
        attempt,
        verdicts,
        lastResult,
        usage,
        retries,
      );
    }

    let verdict;
    try {
      verdict = await evaluate(result, attempt);
    } catch (err) {
      reporter.notice(`goal stopped: judge error (${truncate(err.message)})`);
      return finish(
        false,
        'judge-error',
        attempt,
        verdicts,
        lastResult,
        usage,
        retries,
        { message: err.message, name: err.name, stack: err.stack },
      );
    }
    verdicts.push(verdict);
    addUsage(usage, verdict.usage);
    retries += verdict.retries || 0;

    if (verdict.met && verdict.grounded) {
      reporter.notice('goal met');
      return finish(true, 'met', attempt, verdicts, lastResult, usage, retries);
    }
    if (verdict.met && !verdict.grounded) {
      reporter.notice(
        'goal reported met but ungrounded (no files inspected) — continuing',
      );
    }

    const changed = (result.filesChanged || []).length > 0;
    if (changed) {
      noChangeStreak = 0;
    } else {
      noChangeStreak += 1;
    }
    if (noChangeStreak >= 2) {
      reporter.notice('goal stalled: two attempts changed no files');
      return finish(
        false,
        'stalled',
        attempt,
        verdicts,
        lastResult,
        usage,
        retries,
      );
    }

    continuation = {
      priorMessages: result.messages || [],
      priorFilesChanged: result.filesChanged || [],
    };
  }

  return finish(
    false,
    'exhausted',
    maxAttempts,
    verdicts,
    lastResult,
    usage,
    retries,
  );
}

function finish(
  met,
  reason,
  attempts,
  verdicts,
  lastResult,
  usage,
  retries,
  judgeError,
) {
  const result = {
    met,
    reason,
    attempts,
    verdicts,
    lastResult,
    usage,
    retries,
  };
  if (judgeError) {
    result.judgeError = judgeError;
  }
  return result;
}

/**
 * Cap an error message for a one-line reporter notice -- a judge failure can
 * carry a raw backend error body (e.g. an HTML 500 page, see
 * specs/model-client.yaml) as its message, and that has no place filling the
 * terminal. The full message is still preserved on the returned judgeError.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
function truncate(text, maxChars = 200) {
  const source = typeof text === 'string' ? text : '';
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, maxChars)}… [truncated]`;
}

/**
 * @typedef {object} GoalSummary
 * @property {boolean} met
 * @property {string} reason
 * @property {number} attempts
 * @property {{ prompt: number, completion: number, cost: number }} usage
 * @property {number} retries
 * @property {Array<{ met: boolean, grounded: boolean, source: string }>} verdicts
 * @property {string|null} stoppedReason
 * @property {boolean|null} verified
 * @property {string[]} filesChanged
 * @property {string} response
 */

/**
 * A compact, machine-readable summary of a goal loop for --json mode.
 * @param {GoalResult} result
 * @returns {GoalSummary}
 */
export function summarizeGoalResult(result) {
  return {
    met: result.met,
    reason: result.reason,
    attempts: result.attempts,
    usage: result.usage ?? { prompt: 0, completion: 0, cost: 0 },
    retries: result.retries ?? 0,
    verdicts: (result.verdicts ?? []).map((verdict) => ({
      met: verdict.met,
      grounded: verdict.grounded,
      // "judge" or "review" -- so --json says *why* an attempt was not met,
      // rather than leaving a review-blocked attempt looking like the judge
      // read the workspace and disagreed.
      source: verdict.source ?? 'judge',
    })),
    stoppedReason: result.lastResult?.stoppedReason ?? null,
    verified: result.lastResult?.verification?.passed ?? null,
    filesChanged: result.lastResult?.filesChanged ?? [],
    response: result.lastResult?.response ?? '',
  };
}
