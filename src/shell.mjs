/**
 * Shared shell command runner.
 *
 * Spawns `/bin/sh -c <command>` with a curated environment, a generous
 * timeout, and bounded output. The single execution path for both the
 * run_command tool and verification, so the two cannot diverge.
 *
 * Never throws: a non-zero exit, a signal (including the SIGTERM sent on
 * timeout), or a buffer overflow are all reported as a non-zero exitCode.
 */

import { execFile, execFileSync } from 'node:child_process';
import { buildEnv } from './env.mjs';

// Local models are slow and may drive long builds or test suites, so the
// default is generous. Callers can shorten it per command.
export const DEFAULT_TIMEOUT = 600_000; // 10 minutes
export const DEFAULT_MAX_OUTPUT = 50_000; // characters per stream
// Grace period between SIGTERM and SIGKILL when a timed-out command tree
// doesn't exit on its own.
export const DEFAULT_KILL_GRACE_MS = 5_000;
// Bound on the `ps` call used to find a timed-out command's descendants --
// this runs synchronously on the event loop, so a wedged `ps` must not be
// able to hang it indefinitely and reintroduce the exact class of bug this
// mechanism exists to close.
export const DEFAULT_PS_TIMEOUT_MS = 2_000;

/**
 * Run a shell command and resolve with its captured output.
 * @param {string} command - Shell command to run
 * @param {string} cwd - Working directory
 * @param {object} [options]
 * @param {number} [options.timeout] - Timeout in ms (default 10 minutes)
 * @param {number} [options.maxOutput] - Max characters kept per stream
 * @param {Record<string, string>} [options.env] - Child environment
 * @param {number} [options.heartbeatMs] - Interval for onHeartbeat while the
 *   command runs (0 or omitted disables it). A generous timeout (like the
 *   10-minute default above) is otherwise silent the whole time it runs, so
 *   a genuine long wait and a stuck command look identical from the outside.
 * @param {function} [options.onHeartbeat] - Called with elapsed ms on each tick
 * @param {number} [options.killGraceMs] - Delay before escalating a timed-out
 *   command tree from SIGTERM to SIGKILL (default 5 seconds)
 * @param {number} [options.psTimeoutMs] - Timeout for the `ps` call used to
 *   find a timed-out command's descendants (default 2 seconds)
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runShell(command, cwd, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const env = options.env ?? buildEnv();
  const heartbeatMs = options.heartbeatMs ?? 0;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const psTimeoutMs = options.psTimeoutMs ?? DEFAULT_PS_TIMEOUT_MS;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let heartbeatTimer;
    let timeoutTimer;
    let killGraceTimer;
    let timedOut = false;
    // Once the timeout fires, the escalation to SIGKILL must run to
    // completion even if the immediate child dies from SIGTERM (which
    // resolves this promise) before a stubborn grandchild does. Otherwise
    // the callback below cancels killGraceTimer before it ever gets to
    // clean up the survivor.
    let escalationArmed = false;

    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, maxBuffer: maxOutput * 2, env },
      (err, stdout, stderr) => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        clearTimeout(timeoutTimer);
        if (!escalationArmed) {
          clearTimeout(killGraceTimer);
        }
        resolve({
          stdout: truncate(stdout || '', maxOutput),
          stderr: truncate(stderr || '', maxOutput),
          exitCode: timedOut ? 1 : exitCodeFrom(err),
        });
      },
    );

    if (timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        escalationArmed = true;
        // Snapshot the tree once and reuse it for both signals: once
        // SIGTERM lands, any process in the tree that dies gets its
        // surviving children reparented (to init), which severs the ppid
        // chain a second lookup at SIGKILL time would need to rediscover
        // them by.
        const pids = descendantPids(child.pid, psTimeoutMs);
        killPids(pids, 'SIGTERM');
        killGraceTimer = setTimeout(() => {
          killPids(pids, 'SIGKILL');
        }, killGraceMs);
        killGraceTimer.unref?.();
      }, timeout);
      timeoutTimer.unref?.();
    }

    if (heartbeatMs > 0 && options.onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        options.onHeartbeat(Date.now() - startedAt);
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    }
  });
}

function killPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone -- nothing left to signal.
    }
  }
}

/**
 * Find a command and every process it spawned, not just the immediate
 * /bin/sh child. execFile's own `timeout` option only signals that
 * immediate child -- if it spawns further processes (npm -> node --test,
 * for example), the grandchildren are left running as orphans once the
 * timeout fires and the callback resolves. Walking ppid relationships
 * (rather than relying on process groups, which some sandboxed/
 * containerized hosts silently refuse to create) finds the whole tree
 * regardless of how deep it goes.
 */
function descendantPids(rootPid, psTimeoutMs) {
  if (!rootPid) {
    return [];
  }
  let table;
  try {
    table = execFileSync('ps', ['-Ao', 'pid,ppid'], {
      timeout: psTimeoutMs,
    }).toString();
  } catch {
    return [rootPid];
  }

  const childrenByParent = new Map();
  for (const line of table.split('\n').slice(1)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) {
      continue;
    }
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }

  const pids = [rootPid];
  const visited = new Set(pids);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of childrenByParent.get(parent) ?? []) {
      if (visited.has(child)) {
        continue;
      }
      visited.add(child);
      pids.push(child);
      queue.push(child);
    }
  }
  return pids;
}

/**
 * Normalize an execFile error to a numeric exit code. A numeric `code` is the
 * process exit status; anything else (a signal name, the maxBuffer error
 * string, a null code on timeout) is reported as a generic failure.
 */
function exitCodeFrom(err) {
  if (!err) {
    return 0;
  }
  if (typeof err.code === 'number') {
    return err.code;
  }
  return 1;
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated]`;
}
