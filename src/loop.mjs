/**
 * `kodr loop` -- the ratchet examples/loop.sh and examples/phased-loop.sh
 * already implement (commit on green, retry in place on red, revert-and-
 * park on giving up), promoted out of bash into the harness proper
 * (specs/loop.yaml). specs/loop-scripts.yaml pins the contract; this module
 * adopts it wholesale and changes only what runs it.
 *
 * runLoop is pure orchestration over injected collaborators -- the checklist
 * (nextTask, markTask), the two builders (buildTask wrapping run(), buildGoal
 * wrapping runGoal()), the git ratchet (commitGreen, park), and the clock
 * (now, wait) -- exactly the pattern goal.yaml's runGoal already sets. Loop
 * control (attempt capping, retry routing, backoff placement, green
 * decisions, park sequencing, budget checks) is unit-tested with no model,
 * no network, and no git. The CLI wires the real collaborators (src/cli.mjs),
 * the same split goal.mjs and its own CLI command already use.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createLoopRecord } from './loop-record.mjs';
import { createNullReporter } from './reporter.mjs';
import {
  buildReviewRetryPrompt,
  failOnReviewEnabled,
  reviewBlocks,
} from './review.mjs';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_GOAL_MAX_ATTEMPTS = 4;
export const DEFAULT_RETRY_BACKOFF_MS = 5000;
export const DEFAULT_STOP_ON_PARK = true;
export const DEFAULT_TASKS_FILE = 'TASKS.md';

const GOAL_PREFIX = 'GOAL: ';

/**
 * A checklist item in any of its three states -- unchecked, done, parked.
 * Used for counting the file's items, never for finding the next one (that is
 * `- [ ] ` alone).
 */
const CHECKLIST_ITEM = /^- \[[ x!]\] /;

/**
 * Outer retries per plain task before parking. Resolved from an explicit
 * option, then KODR_LOOP_MAX_ATTEMPTS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function loopMaxAttempts(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_LOOP_MAX_ATTEMPTS, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_MAX_ATTEMPTS;
}

/**
 * Attempt cap handed to runGoal per `GOAL: ` item. Resolved from an explicit
 * option, then KODR_LOOP_GOAL_MAX_ATTEMPTS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function loopGoalMaxAttempts(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_LOOP_GOAL_MAX_ATTEMPTS, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_GOAL_MAX_ATTEMPTS;
}

/**
 * Wait before retrying an attempt that ended stoppedReason "error". Resolved
 * from an explicit option, then KODR_LOOP_RETRY_BACKOFF_MS, then the default
 * (0 disables).
 * @param {number} [option]
 * @returns {number}
 */
export function loopRetryBackoffMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_LOOP_RETRY_BACKOFF_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_RETRY_BACKOFF_MS;
}

/**
 * Stop the whole loop when a task parks, rather than carrying on. Resolved
 * from an explicit option, then KODR_LOOP_STOP_ON_PARK, then the default
 * (true -- a checklist is ordered by default).
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function loopStopOnPark(option) {
  if (typeof option === 'boolean') {
    return option;
  }
  const env = process.env.KODR_LOOP_STOP_ON_PARK;
  if (env === '1' || env === 'true') {
    return true;
  }
  if (env === '0' || env === 'false') {
    return false;
  }
  return DEFAULT_STOP_ON_PARK;
}

/**
 * Wall-clock ceiling for the whole loop, checked between tasks. Resolved
 * from an explicit option, then KODR_LOOP_MAX_MS, then the default (0,
 * disabled).
 * @param {number} [option]
 * @returns {number}
 */
export function loopMaxLoopMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_LOOP_MAX_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return 0;
}

/**
 * Cumulative cost ceiling across the whole loop, checked between tasks.
 * Resolved from an explicit option, then KODR_LOOP_MAX_COST, then the
 * default (0, disabled).
 * @param {number} [option]
 * @returns {number}
 */
export function loopMaxLoopCost(option) {
  if (typeof option === 'number' && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseFloat(process.env.KODR_LOOP_MAX_COST);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return 0;
}

/**
 * Ceiling on tasks attempted in one invocation. Resolved from an explicit
 * option, then KODR_LOOP_MAX_TASKS, then the default (0, disabled).
 * @param {number} [option]
 * @returns {number}
 */
export function loopMaxTasks(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_LOOP_MAX_TASKS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return 0;
}

/**
 * The checklist file. Resolved from an explicit option, then
 * KODR_LOOP_TASKS_FILE, then the default.
 * @param {string} [option]
 * @returns {string}
 */
export function loopTasksFile(option) {
  if (typeof option === 'string' && option) {
    return option;
  }
  const fromEnv = process.env.KODR_LOOP_TASKS_FILE;
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_TASKS_FILE;
}

/**
 * Gitignored paths to wipe on park, alongside `git reset --hard`. Resolved
 * from an explicit option (non-empty array), then KODR_LOOP_RESET_PATHS
 * (space-separated, matching examples/loop.sh's own env var), then empty
 * (disabled).
 * @param {string[]} [option]
 * @returns {string[]}
 */
export function loopResetPaths(option) {
  if (Array.isArray(option) && option.length > 0) {
    return option;
  }
  const fromEnv = process.env.KODR_LOOP_RESET_PATHS;
  if (fromEnv) {
    return fromEnv.split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Split a checklist line into its kind and the text handed to the builder --
 * a `GOAL: ` prefix routes to runGoal, everything else to run().
 * @param {string} task
 * @returns {{ kind: 'task'|'goal', text: string }}
 */
export function classifyTask(task) {
  if (task.startsWith(GOAL_PREFIX)) {
    return { kind: 'goal', text: task.slice(GOAL_PREFIX.length) };
  }
  return { kind: 'task', text: task };
}

/**
 * The first unchecked `- [ ] ` line in the checklist, with the line index it
 * came from. Null when the backlog is done or the file doesn't exist. The
 * index is what makes the later mark safe: marking by re-scanning for "the
 * first unchecked line" silently moves the mark when something else ticks a
 * line mid-attempt, which a capable model does to its own work after reading
 * the `kodr: ` convention out of git log (BACKLOG #8).
 *
 * `index`/`total` are the task's 1-based position among every checklist item
 * and the count of them, which is what lets the loop say "task 3 of 15". The
 * loop's own iteration count cannot: a resumed run's first task is its task 1
 * but the checklist's task 7 (BACKLOG #13).
 * @param {string} tasksFile
 * @returns {Promise<{ text: string, line: number, index: number, total: number }|null>}
 */
export async function readNextTask(tasksFile) {
  let content;
  try {
    content = await readFile(tasksFile, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  const line = lines.findIndex((l) => /^- \[ \] /.test(l));
  if (line === -1) {
    return null;
  }
  // Counted by position, not by matching the line's text: two identically
  // worded items are legal, and indexOf would report the first one's place
  // for both.
  const isItem = (l) => CHECKLIST_ITEM.test(l);
  return {
    text: lines[line].replace(/^- \[ \] /, ''),
    line,
    index: lines.slice(0, line).filter(isItem).length + 1,
    total: lines.filter(isItem).length,
  };
}

/**
 * Flip one specific checklist line's marker to `mark` ('x' = done, '!' =
 * parked). Refuses a line that is out of range or no longer unchecked rather
 * than marking the wrong task: a mismatch means the file moved under the
 * loop, and the honest response is to stop and let the operator look.
 *
 * One already-marked line is accepted instead of refused: the one already
 * reading exactly what this call was about to write. See markedSameTask --
 * refusing that case cost an 83-minute run its last green phase (BACKLOG
 * #12).
 * @param {string} tasksFile
 * @param {number} line - Line index from readNextTask
 * @param {string} mark
 * @param {string|null} [expectedText] - Task text from readNextTask, for the
 *   already-marked check. Without it an already-marked line is always refused.
 * @returns {Promise<{ ok: boolean, error?: string, alreadyMarked?: boolean }>}
 */
export async function markTaskAt(tasksFile, line, mark, expectedText) {
  const content = await readFile(tasksFile, 'utf8');
  const lines = content.split('\n');
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) {
    return { ok: false, error: `checklist has no line at index ${line}` };
  }
  if (!/^- \[ \] /.test(lines[line])) {
    if (markedSameTask(lines[line], mark, expectedText)) {
      return { ok: true, alreadyMarked: true };
    }
    return {
      ok: false,
      error: `checklist line ${line + 1} is no longer unchecked -- refusing to mark a different task`,
    };
  }
  lines[line] = lines[line].replace(/^- \[ \] /, `- [${mark}] `);
  await writeFile(tasksFile, lines.join('\n'));
  return { ok: true };
}

/**
 * Whether an already-marked line is *the very line this mark would have
 * written* -- same marker, same task text. Then the write is a no-op and
 * refusing it is pure loss: the model tidied the checklist itself, which is
 * the tidy thing to do, not the adversarial one. It reads the `- [x]`
 * convention off the lines above and copies it; in the run that found this
 * (BACKLOG #12) its own words were "Marking the phase complete in TASKS.md
 * (consistent with how prior phases were recorded)".
 *
 * Strict whole-line equality, deliberately: a different marker, reworded
 * text, or a line that moved all still fall through to the refusal, because
 * none of them prove the loop and the file agree about which task this is.
 * No expectedText means there is nothing to prove it with, so an
 * already-marked line is refused as before -- the conservative direction,
 * since the guard exists to never mark a task nobody judged.
 * @param {string} current - The line as it stands on disk
 * @param {string} mark
 * @param {string|null} [expectedText]
 * @returns {boolean}
 */
function markedSameTask(current, mark, expectedText) {
  if (typeof expectedText !== 'string') {
    return false;
  }
  return current === `- [${mark}] ${expectedText}`;
}

/**
 * How a task is named in the run's output: its position in the checklist
 * ("task 3/15") when the collaborator can report one, else the loop's own
 * iteration count ("task 3"). `progress` is optional in the checklist
 * contract the same way `headSha` is optional in the git one, so a caller
 * without it degrades rather than failing.
 * @param {{ index: number, total: number }|null} progress
 * @param {number} attempted - Tasks attempted this invocation, including this one
 * @returns {string}
 */
function taskLabel(progress, attempted) {
  if (progress && progress.total > 0) {
    return `task ${progress.index}/${progress.total}`;
  }
  return `task ${attempted}`;
}

/** Whole seconds, for the per-task verdict line. */
function seconds(ms) {
  return Math.round(ms / 1000);
}

/**
 * A plain task's green decision -- completed AND not a no-op completion AND
 * verification did not fail. Mirrors specs/loop-scripts.yaml's ratchet.
 * @param {import('./harness.mjs').RunResult} result
 * @returns {boolean}
 */
export function taskIsGreen(result, options = {}) {
  if (options.failOnReview && reviewBlocks(result?.review)) {
    return false;
  }
  return (
    result?.stoppedReason === 'complete' &&
    !result?.noOpCompletion &&
    result?.verification?.passed !== false
  );
}

/**
 * A `GOAL: ` item's green decision -- met AND filesChanged non-empty AND
 * verification did not fail.
 * @param {import('./goal.mjs').GoalResult} goalResult
 * @returns {boolean}
 */
export function goalIsGreen(goalResult, options = {}) {
  // Belt and braces: with withReviewGate wired the judge already returned
  // not-met for a blocked review, so `met` is false here. This still holds for
  // a caller that drives runGoal without the wrapper.
  if (options.failOnReview && reviewBlocks(goalResult?.lastResult?.review)) {
    return false;
  }
  const filesChanged = goalResult?.lastResult?.filesChanged ?? [];
  const verifiedFailed = goalResult?.lastResult?.verification?.passed === false;
  return Boolean(goalResult?.met) && filesChanged.length > 0 && !verifiedFailed;
}

/**
 * Startup preconditions, checked before spending a model call. Injected
 * predicates so this is unit-tested without touching real git or the
 * filesystem; the CLI wires real ones (loop-git.mjs, fs.existsSync).
 * @param {object} params
 * @param {() => Promise<boolean>} params.isRepo
 * @param {() => Promise<boolean>} params.tasksFileExists
 * @param {() => Promise<boolean>} params.hasCommits
 * @param {() => Promise<boolean>} params.tasksFileTracked
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function validateLoopStart(params) {
  const { isRepo, tasksFileExists, hasCommits, tasksFileTracked } = params;
  if (!(await isRepo())) {
    return { ok: false, message: 'not a git repo' };
  }
  if (!(await tasksFileExists())) {
    return { ok: false, message: 'checklist file not found' };
  }
  if (!(await hasCommits())) {
    return {
      ok: false,
      message:
        'no commits in this repo yet -- commit the checklist before starting ' +
        '(a park runs a hard reset + clean; with nothing tracked, that deletes the checklist)',
    };
  }
  // hasCommits only proves *a* commit exists somewhere in the repo, not that
  // the checklist itself is one of the tracked files -- an untracked
  // TASKS.md survives no park at all: `git clean -fd` deletes it outright on
  // the very first one, taking the plan with it (specs/loop-scripts.yaml,
  // bug 7's exact class).
  if (!(await tasksFileTracked())) {
    return {
      ok: false,
      message:
        'checklist is not tracked by git -- commit it before starting ' +
        '(a park runs git clean -fd; an untracked checklist would be deleted on the first one)',
    };
  }
  return { ok: true };
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
 * Run a plain task's outer retry loop: buildTask(text, continuation), up to
 * maxAttempts, retrying in place with the prior transcript replayed on red.
 * Backoff fires only when an attempt ends stoppedReason "error" and only
 * when another attempt will follow -- a genuine build/test failure gets no
 * delay, and a park already happening is not delayed.
 * @param {string} text
 * @param {object} ctx
 * @param {(text: string, continuation: object|null) => Promise<import('./harness.mjs').RunResult>} ctx.buildTask
 * @param {number} ctx.maxAttempts
 * @param {number} ctx.backoffMs
 * @param {{ now: () => number, wait: (ms: number) => Promise<void> }} ctx.clock
 * @param {import('./reporter.mjs').Reporter} ctx.reporter
 * @param {(result: import('./harness.mjs').RunResult) => void} ctx.onAttempt
 * @param {string} [ctx.label] - How this task is named in the output ("task 3/15")
 * @param {boolean} [ctx.failOnReview]
 * @returns {Promise<{ isGreen: boolean, attempts: number, result: import('./harness.mjs').RunResult|null, usage: { prompt: number, completion: number, cost: number }, allErrored: boolean }>}
 */
async function attemptTask(text, ctx) {
  const { buildTask, maxAttempts, backoffMs, clock, reporter, onAttempt } = ctx;
  const failOnReview = Boolean(ctx.failOnReview);
  const label = ctx.label || 'task';
  let attempt = 0;
  let continuation = null;
  let result = null;
  let isGreen = false;
  let prompt = text;
  let errored = 0;
  const usage = { prompt: 0, completion: 0, cost: 0 };

  while (attempt < maxAttempts) {
    attempt += 1;
    // Announced *before* the build, not after: this is the line that tells an
    // operator watching a log whether the next few minutes are a new task or
    // another go at the current one, which nothing in the output said before
    // (BACKLOG #13).
    reporter.notice(`kodr loop: ${label} attempt ${attempt}/${maxAttempts}`);
    result = await buildTask(prompt, continuation);
    addUsage(usage, result.usage);
    onAttempt(result);
    if (result.stoppedReason === 'error') {
      errored += 1;
    }
    isGreen = taskIsGreen(result, { failOnReview });
    if (isGreen) {
      break;
    }
    if (taskWasCancelled(result)) {
      // A Ctrl-C mid-attempt (specs/cancel.yaml) is not a build failure --
      // burning the remaining attempts against an already-aborted signal, or
      // parking (reset --hard + clean -fd) over whatever the operator just
      // interrupted, would both be wrong. Stop retrying immediately; the
      // caller checks taskWasCancelled(result) and skips the ratchet entirely.
      break;
    }
    continuation = {
      priorMessages: result.messages || [],
      priorFilesChanged: result.filesChanged || [],
    };
    // A blocked review is the one failure that comes with an explanation, so
    // hand it over instead of re-sending the task verbatim and hoping the
    // model lands somewhere different. run() only reviews a completed build,
    // so reaching here with a blocking review means the attempt would
    // otherwise have been green -- this can never mask a test failure.
    prompt = text;
    if (failOnReview && reviewBlocks(result.review)) {
      prompt = buildReviewRetryPrompt(text, result.review);
      reporter.notice(
        `attempt ${attempt} failed review -- retrying with the reviewer's findings`,
      );
    }
    if (result.stoppedReason === 'error' && attempt < maxAttempts) {
      reporter.notice(
        `attempt ${attempt} ended in a transient error -- backing off ${backoffMs}ms before retry`,
      );
      if (backoffMs > 0) {
        await clock.wait(backoffMs);
      }
    }
  }

  // allErrored, not "the last attempt errored": a task that errored once and
  // then ran and failed its gate did get a fair attempt, and should park like
  // any other failure (BACKLOG #10).
  return {
    isGreen,
    attempts: attempt,
    result,
    usage,
    allErrored: attempt > 0 && errored === attempt,
  };
}

// Just the decision, not the findings -- the loop record is a per-task
// summary, and the full review (findings included) is already on the run
// record in .kodr/runs. Enough to answer "which tasks did the reviewer
// block?" from one file after an overnight run.
function reviewEntry(review) {
  if (!review) {
    return null;
  }
  if (review.skipped) {
    return { skipped: true };
  }
  return {
    verdict: review.verdict,
    grounded: review.grounded ?? null,
    passed: review.passed ?? null,
  };
}

/**
 * Whether a plain task's RunResult signals a Ctrl-C cancellation
 * (specs/cancel.yaml) rather than a genuine build failure.
 * @param {import('./harness.mjs').RunResult|null} result
 * @returns {boolean}
 */
function taskWasCancelled(result) {
  return result?.stoppedReason === 'cancelled';
}

/**
 * Whether a GOAL: item was cancelled.
 *
 * runGoal's own `reason` is the reliable signal and is checked first: it
 * reports "cancelled" in two cases where the last *build* looks perfectly
 * healthy -- a cancel caught between attempts (lastResult is the previous,
 * uncancelled attempt) and one caught after a build that itself completed,
 * with the signal firing during that attempt's post-build phase. Reading
 * lastResult.stoppedReason alone missed both, and missing a cancel here is
 * expensive: the caller falls through to park(), which is reset --hard plus
 * clean -fd over the work the operator just interrupted.
 *
 * The stoppedReason check stays as a fallback for a GoalResult assembled by
 * something other than runGoal.
 * @param {import('./goal.mjs').GoalResult} goalResult
 * @returns {boolean}
 */
function goalWasCancelled(goalResult) {
  if (goalResult?.reason === 'cancelled') {
    return true;
  }
  return goalResult?.lastResult?.stoppedReason === 'cancelled';
}

/**
 * @typedef {object} LoopResult
 * @property {string} reason - "backlog-empty" | "budget" | "parked" | "commit-failed" | "cancelled" | "mark-failed" | "attempts-errored"
 * @property {Array} tasks
 * @property {number} green
 * @property {number} parked
 * @property {{ prompt: number, completion: number, cost: number }} usage
 * @property {number} retries
 * @property {number} durationMs
 * @property {string|null} recordPath
 */

/**
 * The loop. Pure orchestration over injected collaborators: checklist
 * (nextTask, markTask), buildTask/buildGoal (the per-task builders), git
 * (commitGreen, park), and clock (now, wait). Stops on an empty backlog, a
 * budget ceiling (checked between tasks only), a park when stopOnPark is
 * set, or a failed git commit -- the loop never continues past a git
 * failure on the assumption that it worked.
 * @param {object} params
 * @param {{ nextTask: () => Promise<string|null>, markTask: (mark: string) => Promise<{ok: boolean, error?: string, alreadyMarked?: boolean}>, progress?: () => ({ index: number, total: number }|null|Promise<{ index: number, total: number }|null>) }} params.checklist
 * @param {(text: string, continuation: object|null) => Promise<import('./harness.mjs').RunResult>} params.buildTask
 * @param {(goalText: string) => Promise<import('./goal.mjs').GoalResult>} params.buildGoal
 * @param {{ commitGreen: (message: string) => Promise<{ok: boolean, sha?: string, error?: string, reason?: string}>, park: (resetPaths: string[], resetTo?: string|null) => Promise<{ok: boolean, error?: string, wiped?: string[], refused?: string[]}>, headSha?: () => Promise<string|null> }} params.git
 * @param {{ now: () => number, wait: (ms: number) => Promise<void> }} [params.clock]
 * @param {string[]} [params.resetPaths]
 * @param {number} [params.maxAttempts]
 * @param {number} [params.retryBackoffMs]
 * @param {boolean} [params.stopOnPark]
 * @param {boolean} [params.failOnReview] - A blocking review verdict stops a
 *   task going green; the retry is prompted with the reviewer's findings
 * @param {number} [params.maxLoopMs]
 * @param {number} [params.maxLoopCost]
 * @param {number} [params.maxTasks]
 * @param {import('./reporter.mjs').Reporter} [params.reporter]
 * @param {(record: import('./loop-record.mjs').LoopRecord) => Promise<void>|void} [params.onRecord] - Called
 *   after every task transition with the current record snapshot; the CLI
 *   binds this to loop-record.mjs's writeLoopRecord.
 * @param {string|null} [params.recordPath] - Echoed back on the result;
 *   runLoop never touches the filesystem itself.
 * @returns {Promise<LoopResult>}
 */
export async function runLoop(params) {
  const {
    checklist,
    buildTask,
    buildGoal,
    git,
    clock = {
      now: () => Date.now(),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    reporter = createNullReporter(),
    onRecord,
    recordPath = null,
  } = params;

  const maxAttempts = loopMaxAttempts(params.maxAttempts);
  const backoffMs = loopRetryBackoffMs(params.retryBackoffMs);
  const stopOnPark = loopStopOnPark(params.stopOnPark);
  const failOnReview = failOnReviewEnabled(params.failOnReview);
  const maxLoopMs = loopMaxLoopMs(params.maxLoopMs);
  const maxLoopCost = loopMaxLoopCost(params.maxLoopCost);
  const maxTasks = loopMaxTasks(params.maxTasks);
  const resetPaths = loopResetPaths(params.resetPaths);

  const record = createLoopRecord(new Date());
  const startTime = clock.now();
  const usage = { prompt: 0, completion: 0, cost: 0 };
  let retries = 0;
  let green = 0;
  let parked = 0;
  let tasksAttempted = 0;

  const snapshot = (reason) => {
    if (reason !== undefined) {
      record.reason = reason;
    }
    record.green = green;
    record.parked = parked;
    record.usage = usage;
    record.retries = retries;
    record.durationMs = clock.now() - startTime;
    return record;
  };

  const emit = async (reason) => {
    snapshot(reason);
    if (onRecord) {
      await onRecord(record);
    }
  };

  const finish = (reason) => ({
    reason,
    tasks: record.tasks,
    green,
    parked,
    usage,
    retries,
    durationMs: clock.now() - startTime,
    recordPath,
  });

  while (true) {
    if (maxTasks > 0 && tasksAttempted >= maxTasks) {
      await emit('budget');
      return finish('budget');
    }
    if (maxLoopMs > 0 && clock.now() - startTime >= maxLoopMs) {
      await emit('budget');
      return finish('budget');
    }
    if (maxLoopCost > 0 && usage.cost >= maxLoopCost) {
      await emit('budget');
      return finish('budget');
    }

    const task = await checklist.nextTask();
    if (task === null) {
      await emit('backlog-empty');
      return finish('backlog-empty');
    }

    tasksAttempted += 1;
    const taskStart = clock.now();
    // HEAD before the attempt touches anything. A park resets to this sha
    // rather than to whatever HEAD became, because the model may have
    // committed its own work mid-attempt -- a bare `git reset --hard` keeps
    // that commit and parks a task whose work is still in history
    // (BACKLOG #8).
    const baseSha = git.headSha ? await git.headSha() : null;
    const { kind, text } = classifyTask(task);
    const label = taskLabel(
      checklist.progress ? await checklist.progress() : null,
      tasksAttempted,
    );
    reporter.phase(`loop task ${tasksAttempted} (${kind}): ${task}`);
    reporter.notice(`kodr loop: ${label} (${kind}) ${task}`);

    let entry;
    let isGreen;
    let cancelled;
    // A GOAL: item has no equivalent -- runGoal owns its own attempt loop and
    // reports its own reason -- so this stays false on that branch.
    let allErrored = false;
    let lastError = null;

    if (kind === 'goal') {
      const goalResult = await buildGoal(text);
      addUsage(usage, goalResult.usage);
      retries += goalResult.retries || 0;
      isGreen = goalIsGreen(goalResult, { failOnReview });
      cancelled = goalWasCancelled(goalResult);
      entry = {
        task,
        kind: 'goal',
        status: isGreen ? 'green' : 'parked',
        attempts: goalResult.attempts,
        goalReason: goalResult.reason,
        filesChanged: goalResult.lastResult?.filesChanged ?? [],
        usage: goalResult.usage ?? { prompt: 0, completion: 0, cost: 0 },
        review: reviewEntry(goalResult.lastResult?.review),
        durationMs: clock.now() - taskStart,
        // Not populated in P0 -- run() doesn't return the path its own
        // saved transcript landed at, only .kodr/runs/ on disk.
        runRecords: [],
      };
    } else {
      const attemptOutcome = await attemptTask(text, {
        buildTask,
        maxAttempts,
        backoffMs,
        clock,
        reporter,
        failOnReview,
        label,
        onAttempt: (result) => {
          addUsage(usage, result.usage);
          retries += result.retries || 0;
        },
      });
      isGreen = attemptOutcome.isGreen;
      const { attempts, result, usage: taskUsage } = attemptOutcome;
      cancelled = taskWasCancelled(result);
      allErrored = attemptOutcome.allErrored;
      lastError = result?.error?.message ?? null;
      entry = {
        task,
        kind: 'task',
        status: isGreen ? 'green' : 'parked',
        attempts,
        stoppedReason: result?.stoppedReason ?? null,
        filesChanged: result?.filesChanged ?? [],
        usage: taskUsage,
        review: reviewEntry(result?.review),
        durationMs: clock.now() - taskStart,
        runRecords: [],
      };
    }

    if (cancelled) {
      // Leave the checklist and the workspace exactly as the cancelled
      // build/goal attempt left them -- no mark, no commit, no park (no
      // reset --hard, no clean -fd) over work the operator just interrupted.
      entry.status = 'cancelled';
      record.tasks.push(entry);
      await emit('cancelled');
      return finish('cancelled');
    }

    if (allErrored) {
      // Every attempt threw instead of producing a verdict, so there is
      // nothing to judge. Rewind the workspace, but leave the checklist line
      // unchecked: '!' means "the model was given a fair attempt and did not
      // pass the gate", and a task that never got an answer has not earned
      // that mark. Marking it would retire the task permanently -- no later
      // run re-attempts a marked line -- so a provider that was briefly
      // unreachable would silently truncate the whole backlog (BACKLOG #10).
      entry.status = 'errored';
      if (lastError) {
        entry.error = lastError;
      }
      const erroredPark = await git.park(resetPaths, baseSha);
      if (!erroredPark.ok) {
        entry.error = erroredPark.error;
        record.tasks.push(entry);
        await emit('commit-failed');
        return finish('commit-failed');
      }
      for (const refused of erroredPark.refused ?? []) {
        reporter.notice(`resetPaths: refusing to wipe '${refused}'`);
      }
      let notice = `kodr: ${task} -- every attempt errored, left unchecked for a rerun`;
      if (lastError) {
        notice = `${notice}: ${lastError}`;
      }
      reporter.notice(notice);
      record.tasks.push(entry);
      // Unconditional, not gated on stopOnPark: whatever broke the attempts
      // will break the next task too, and carrying on would walk the backlog
      // turning every line into the same non-verdict.
      await emit('attempts-errored');
      return finish('attempts-errored');
    }

    if (isGreen) {
      const markResult = await checklist.markTask('x');
      if (markResult && !markResult.ok) {
        entry.error = markResult.error;
        record.tasks.push(entry);
        await emit('mark-failed');
        return finish('mark-failed');
      }
      // Accepted, not refused (BACKLOG #12) -- but say so, because the model
      // editing the checklist is worth knowing about even when it is harmless,
      // and silence here is how it stayed invisible until it stopped a run.
      if (markResult?.alreadyMarked) {
        entry.markedByAttempt = true;
        reporter.notice(
          `kodr: ${task} -- the attempt had already ticked this line itself; left as it stands`,
        );
      }
      const commitResult = await git.commitGreen(`kodr: ${task}`);
      if (!commitResult.ok && commitResult.error) {
        entry.error = commitResult.error;
        record.tasks.push(entry);
        await emit('commit-failed');
        return finish('commit-failed');
      }
      // reason (no error) means "nothing to commit" -- the checklist mark
      // itself is always a real diff, so this shouldn't fire in normal use,
      // but it isn't a git failure and shouldn't stop the loop on one.
      if (commitResult.ok) {
        entry.commit = commitResult.sha;
      } else {
        reporter.notice(`kodr: ${task} -- ${commitResult.reason}`);
      }
      // The verdict line. Everything an operator reading a log wants about a
      // finished task, on one line: that it passed, what it cost in attempts
      // and wall clock, and the sha to go and look at.
      reporter.notice(
        `kodr loop: ${label} green in ${entry.attempts} attempt(s), ` +
          `${seconds(entry.durationMs)}s${entry.commit ? ` (${entry.commit})` : ''}`,
      );
      green += 1;
      record.tasks.push(entry);
      await emit();
      continue;
    }

    const parkResult = await git.park(resetPaths, baseSha);
    if (!parkResult.ok) {
      entry.error = parkResult.error;
      record.tasks.push(entry);
      await emit('commit-failed');
      return finish('commit-failed');
    }
    for (const refused of parkResult.refused ?? []) {
      reporter.notice(`resetPaths: refusing to wipe '${refused}'`);
    }

    // No alreadyMarked branch here, unlike the green path: the park above has
    // already rewound the tree to the pre-attempt sha and cleaned it, so
    // whatever the attempt wrote into the checklist is gone by now and the
    // line is back to '[ ]'. Only a green task reaches its mark with the
    // model's own edit still in the file.
    const parkMark = await checklist.markTask('!');
    if (parkMark && !parkMark.ok) {
      entry.error = parkMark.error;
      record.tasks.push(entry);
      await emit('mark-failed');
      return finish('mark-failed');
    }
    const parkCommit = await git.commitGreen(`kodr: park ${task}`);
    if (!parkCommit.ok && parkCommit.error) {
      entry.error = parkCommit.error;
      record.tasks.push(entry);
      await emit('commit-failed');
      return finish('commit-failed');
    }
    if (parkCommit.ok) {
      entry.commit = parkCommit.sha;
    } else {
      reporter.notice(`kodr: park ${task} -- ${parkCommit.reason}`);
    }
    reporter.notice(
      `kodr loop: ${label} parked after ${entry.attempts} attempt(s), ` +
        `${seconds(entry.durationMs)}s -- tree rewound`,
    );
    parked += 1;
    record.tasks.push(entry);
    await emit();

    if (stopOnPark) {
      await emit('parked');
      return finish('parked');
    }
  }
}
