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

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_GOAL_MAX_ATTEMPTS = 4;
export const DEFAULT_RETRY_BACKOFF_MS = 5000;
export const DEFAULT_STOP_ON_PARK = true;
export const DEFAULT_TASKS_FILE = 'TASKS.md';

const GOAL_PREFIX = 'GOAL: ';

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
 * The first unchecked `- [ ] ` line in the checklist, sans the marker. Null
 * when the backlog is done or the file doesn't exist.
 * @param {string} tasksFile
 * @returns {Promise<string|null>}
 */
export async function readNextTask(tasksFile) {
  let content;
  try {
    content = await readFile(tasksFile, 'utf8');
  } catch {
    return null;
  }
  const line = content.split('\n').find((l) => /^- \[ \] /.test(l));
  if (!line) {
    return null;
  }
  return line.replace(/^- \[ \] /, '');
}

/**
 * Flip the first unchecked line's marker to `mark` ('x' = done, '!' =
 * parked). Mirrors the shell scripts' `mark_first` -- "first" is unambiguous
 * within one iteration, since readNextTask always hands back the first
 * unchecked line.
 * @param {string} tasksFile
 * @param {string} mark
 * @returns {Promise<void>}
 */
export async function markFirstTask(tasksFile, mark) {
  const content = await readFile(tasksFile, 'utf8');
  let done = false;
  const lines = content.split('\n').map((line) => {
    if (!done && /^- \[ \] /.test(line)) {
      done = true;
      return line.replace(/^- \[ \] /, `- [${mark}] `);
    }
    return line;
  });
  await writeFile(tasksFile, lines.join('\n'));
}

/**
 * A plain task's green decision -- completed AND not a no-op completion AND
 * verification did not fail. Mirrors specs/loop-scripts.yaml's ratchet.
 * @param {import('./harness.mjs').RunResult} result
 * @returns {boolean}
 */
export function taskIsGreen(result) {
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
export function goalIsGreen(goalResult) {
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
 * @returns {Promise<{ isGreen: boolean, attempts: number, result: import('./harness.mjs').RunResult|null, usage: { prompt: number, completion: number, cost: number } }>}
 */
async function attemptTask(text, ctx) {
  const { buildTask, maxAttempts, backoffMs, clock, reporter, onAttempt } = ctx;
  let attempt = 0;
  let continuation = null;
  let result = null;
  let isGreen = false;
  const usage = { prompt: 0, completion: 0, cost: 0 };

  while (attempt < maxAttempts) {
    attempt += 1;
    result = await buildTask(text, continuation);
    addUsage(usage, result.usage);
    onAttempt(result);
    isGreen = taskIsGreen(result);
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
    if (result.stoppedReason === 'error' && attempt < maxAttempts) {
      reporter.notice(
        `attempt ${attempt} ended in a transient error -- backing off ${backoffMs}ms before retry`,
      );
      if (backoffMs > 0) {
        await clock.wait(backoffMs);
      }
    }
  }

  return { isGreen, attempts: attempt, result, usage };
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
 * Whether a GOAL: item's build attempt was cancelled.
 * @param {import('./goal.mjs').GoalResult} goalResult
 * @returns {boolean}
 */
function goalWasCancelled(goalResult) {
  return goalResult?.lastResult?.stoppedReason === 'cancelled';
}

/**
 * @typedef {object} LoopResult
 * @property {string} reason - "backlog-empty" | "budget" | "parked" | "commit-failed" | "cancelled"
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
 * @param {{ nextTask: () => Promise<string|null>, markTask: (mark: string) => Promise<void> }} params.checklist
 * @param {(text: string, continuation: object|null) => Promise<import('./harness.mjs').RunResult>} params.buildTask
 * @param {(goalText: string) => Promise<import('./goal.mjs').GoalResult>} params.buildGoal
 * @param {{ commitGreen: (message: string) => Promise<{ok: boolean, sha?: string, error?: string, reason?: string}>, park: (resetPaths: string[]) => Promise<{ok: boolean, error?: string, wiped?: string[], refused?: string[]}> }} params.git
 * @param {{ now: () => number, wait: (ms: number) => Promise<void> }} [params.clock]
 * @param {string[]} [params.resetPaths]
 * @param {number} [params.maxAttempts]
 * @param {number} [params.retryBackoffMs]
 * @param {boolean} [params.stopOnPark]
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
    const { kind, text } = classifyTask(task);
    reporter.phase(`loop task ${tasksAttempted} (${kind}): ${task}`);

    let entry;
    let isGreen;
    let cancelled;

    if (kind === 'goal') {
      const goalResult = await buildGoal(text);
      addUsage(usage, goalResult.usage);
      retries += goalResult.retries || 0;
      isGreen = goalIsGreen(goalResult);
      cancelled = goalWasCancelled(goalResult);
      entry = {
        task,
        kind: 'goal',
        status: isGreen ? 'green' : 'parked',
        attempts: goalResult.attempts,
        goalReason: goalResult.reason,
        filesChanged: goalResult.lastResult?.filesChanged ?? [],
        usage: goalResult.usage ?? { prompt: 0, completion: 0, cost: 0 },
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
        onAttempt: (result) => {
          addUsage(usage, result.usage);
          retries += result.retries || 0;
        },
      });
      isGreen = attemptOutcome.isGreen;
      const { attempts, result, usage: taskUsage } = attemptOutcome;
      cancelled = taskWasCancelled(result);
      entry = {
        task,
        kind: 'task',
        status: isGreen ? 'green' : 'parked',
        attempts,
        stoppedReason: result?.stoppedReason ?? null,
        filesChanged: result?.filesChanged ?? [],
        usage: taskUsage,
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

    if (isGreen) {
      await checklist.markTask('x');
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
      green += 1;
      record.tasks.push(entry);
      await emit();
      continue;
    }

    const parkResult = await git.park(resetPaths);
    if (!parkResult.ok) {
      entry.error = parkResult.error;
      record.tasks.push(entry);
      await emit('commit-failed');
      return finish('commit-failed');
    }
    for (const refused of parkResult.refused ?? []) {
      reporter.notice(`resetPaths: refusing to wipe '${refused}'`);
    }

    await checklist.markTask('!');
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
    parked += 1;
    record.tasks.push(entry);
    await emit();

    if (stopOnPark) {
      await emit('parked');
      return finish('parked');
    }
  }
}
