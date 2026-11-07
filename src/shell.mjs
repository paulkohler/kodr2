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

import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
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
// Grace between the end-of-run sweep's SIGTERM and its SIGKILL. Shorter than
// DEFAULT_KILL_GRACE_MS on purpose: that one runs mid-run, where patience is
// free, while this one runs with the operator waiting on an exit -- and it is
// only paid at all when the sweep actually found something.
export const DEFAULT_SWEEP_GRACE_MS = 2_000;

/**
 * Process groups runShell created that may still have members, keyed by group
 * id (the direct child's pid).
 *
 * A command can exit 0 having left something behind -- `nohup server &`
 * redirects away the pipes, so `sh` exits at once and neither the timeout nor
 * the abort path ever runs (BACKLOG #11). Nothing else in the harness looked
 * at children once a command succeeded, so the process outlived `kodr`, still
 * holding its port, and nothing said so. Every group goes in here on spawn and
 * comes out again at close once it is confirmed empty, so what is left at the
 * end of a run is the set of groups that outlived their command.
 * @type {Set<number>}
 */
const detachedGroups = new Set();

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
 * @param {AbortSignal} [options.signal] - Cancellation signal. Kills the
 *   command's process group and answers at once (see specs/cancel.yaml).
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runShell(command, cwd, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const env = options.env ?? buildEnv();
  const heartbeatMs = options.heartbeatMs ?? 0;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const psTimeoutMs = options.psTimeoutMs ?? DEFAULT_PS_TIMEOUT_MS;
  const signal = options.signal;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let heartbeatTimer;
    let timeoutTimer;
    let killGraceTimer;
    let timedOut = false;
    let settled = false;
    let onAbort;
    // Once the timeout fires, the escalation to SIGKILL must run to
    // completion even if the immediate child dies from SIGTERM (which
    // resolves this promise) before a stubborn grandchild does. Otherwise
    // the callback below cancels killGraceTimer before it ever gets to
    // clean up the survivor.
    let escalationArmed = false;

    // detached makes /bin/sh a process group leader, which is what lets a
    // backgrounded orphan be killed at all: process group membership is
    // inherited and survives reparenting, so `kill(-pgid)` still reaches a
    // process that `ps -Ao pid,ppid` can no longer connect to us (see
    // killTree). The child is never unref'd, so Node still waits for it.
    //
    // Typed loosely on purpose: execFile forwards its options to spawn and
    // honours `detached` at runtime, but @types/node leaves it out of
    // ExecFileOptions, so a precise annotation here would be a lie that
    // doesn't compile.
    // spawn, not execFile: execFile silently drops `detached`, leaving the
    // child in the parent's process group (verified -- the child's pgid came
    // back as the launching shell's). Without its own group there is no group
    // to signal, so `kill(-pid)` just ESRCHes and a backgrounded orphan
    // survives. spawn honours it, which is the whole basis of killTree.
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      detached: true,
    });

    if (child.pid) {
      detachedGroups.add(child.pid);
    }

    // execFile's maxBuffer, by hand: stop accumulating past the cap and fail
    // the command, rather than growing a string without limit.
    const cap = maxOutput * 2;
    let stdout = '';
    let stderr = '';
    let overflowed = false;
    const collect = (stream, append) => {
      if (!stream) {
        return;
      }
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (overflowed) {
          return;
        }
        append(chunk);
        if (stdout.length + stderr.length > cap) {
          overflowed = true;
          const pids = descendantPids(child.pid, psTimeoutMs);
          killTree(child.pid, pids, 'SIGKILL', psTimeoutMs);
        }
      });
      stream.on('error', () => {
        // A broken pipe on a killed command is not a failure of its own.
      });
    };
    collect(child.stdout, (c) => {
      stdout += c;
    });
    collect(child.stderr, (c) => {
      stderr += c;
    });

    const finish = (exitCode) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      clearTimeout(timeoutTimer);
      if (!escalationArmed) {
        clearTimeout(killGraceTimer);
      }
      if (onAbort && signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (settled) {
        // The timeout or a cancellation already answered the caller. Still
        // let the kill escalation finish above; just don't resolve twice.
        return;
      }
      settled = true;
      resolve({
        stdout: truncate(stdout, maxOutput),
        stderr: truncate(stderr, maxOutput),
        exitCode,
      });
    };

    // 'close' rather than 'exit': it waits for the stdio streams to drain, so
    // output written just before exit is not lost. A backgrounded orphan can
    // hold those streams open forever, which is why the timeout and the abort
    // path answer the caller themselves.
    child.on('close', (code, signalName) => {
      forgetEmptyGroup(child.pid, psTimeoutMs);
      if (timedOut || overflowed) {
        finish(1);
        return;
      }
      if (typeof code === 'number') {
        finish(code);
        return;
      }
      // Killed by a signal, or no code at all.
      finish(signalName ? 1 : 1);
    });

    child.on('error', (err) => {
      stderr += `${stderr ? '\n' : ''}${err.message}`;
      finish(1);
    });

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
        killTree(child.pid, pids, 'SIGTERM', psTimeoutMs);
        killGraceTimer = setTimeout(() => {
          killTree(child.pid, pids, 'SIGKILL', psTimeoutMs);
        }, killGraceMs);
        killGraceTimer.unref?.();
        // Answer the caller now rather than waiting for execFile's callback,
        // which fires only once the child has exited *and* its stdout and
        // stderr pipes have closed. A backgrounded process keeps those pipes
        // open after `sh` itself exits (`cargo run &`), and because `sh` is
        // gone the orphan has already been reparented to init -- so the ppid
        // walk above finds nothing to kill and nothing ever closes the pipes.
        // That made the timeout unenforceable: a model-issued background
        // command pended for minutes regardless of --command-timeout-ms.
        // Resolving here makes the timeout mean what it says. The orphan is
        // reaped by the group kill above (BACKLOG #9, since fixed -- this
        // comment used to say the module deliberately avoided process groups,
        // which stopped being true when it moved to spawn), and anything that
        // survives even that is caught by the end-of-run sweep.
        if (!settled) {
          settled = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
          resolve({
            stdout: '',
            stderr: `command timed out after ${timeout}ms`,
            exitCode: 1,
          });
        }
      }, timeout);
      timeoutTimer.unref?.();
    }

    // Ctrl-C has to be forwarded explicitly now that the child is detached:
    // a detached child is in its own process group, so the terminal's SIGINT
    // no longer reaches it. This is strictly better than relying on that --
    // terminal delivery never worked for a non-TTY front-end (the loop, ACP)
    // in the first place, where an interrupted run would leave its command
    // running to completion.
    if (signal) {
      onAbort = () => {
        const pids = descendantPids(child.pid, psTimeoutMs);
        killTree(child.pid, pids, 'SIGTERM', psTimeoutMs);
        const graceTimer = setTimeout(() => {
          killTree(child.pid, pids, 'SIGKILL', psTimeoutMs);
        }, killGraceMs);
        graceTimer.unref?.();
        if (!settled) {
          settled = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
          clearTimeout(timeoutTimer);
          resolve({
            stdout: '',
            stderr: 'command cancelled',
            exitCode: 1,
          });
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
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
 * Every process whose process group id is `pid` -- the members of the group
 * the detached child leads.
 *
 * This is the fallback for a host that refuses the group *signal* while still
 * reporting group *membership*: inside an OpenShell sandbox `kill(-pgid)`
 * comes back EPERM (seccomp, confirmed: single-pid kill works on the same
 * process), so the group has to be enumerated and its members killed one at a
 * time. A `ps` lookup by pgid finds the orphan that the ppid walk cannot,
 * because group membership is inherited and survives reparenting while the
 * ppid chain does not.
 *
 * Safe when `detached` was refused, which is the case that would otherwise be
 * catastrophic: a process group's id is its leader's pid, so a row with
 * `pgid == pid` can only exist if our own child created that group. If it
 * never got one, it sits in the parent's group under a different id, nothing
 * matches, and this returns empty rather than selecting Kodr and the user's
 * shell. The current process is excluded regardless.
 * @param {number|undefined} pid - The direct child's pid, i.e. its group id
 * @param {number} psTimeoutMs
 * @returns {number[]}
 */
export function groupMemberPids(pid, psTimeoutMs = DEFAULT_PS_TIMEOUT_MS) {
  if (!pid) {
    return [];
  }
  const rows = psRows('pid,pgid', psTimeoutMs);
  if (!rows) {
    return [];
  }
  const members = [];
  for (const [memberPid, pgid] of rows) {
    if (pgid === pid && memberPid !== process.pid) {
      members.push(memberPid);
    }
  }
  return members;
}

/**
 * Two numeric columns of `ps -Ao`, parsed. Null (not an empty list) when `ps`
 * itself failed, so a caller that has a meaningful fallback for that case can
 * tell it apart from a genuinely empty answer.
 *
 * The lookup is bounded by psTimeoutMs: it runs synchronously on the event
 * loop, so a wedged `ps` must not be able to reintroduce the class of hang
 * this whole mechanism exists to close.
 * @param {string} columns - e.g. 'pid,ppid'
 * @param {number} psTimeoutMs
 * @returns {number[][]|null}
 */
function psRows(columns, psTimeoutMs) {
  let table;
  try {
    table = execFileSync('ps', ['-Ao', columns], {
      timeout: psTimeoutMs,
    }).toString();
  } catch {
    return null;
  }
  const rows = [];
  for (const line of table.split('\n').slice(1)) {
    const [first, second] = line.trim().split(/\s+/).map(Number);
    if (!first || !second) {
      continue;
    }
    rows.push([first, second]);
  }
  return rows;
}

/**
 * Drop a group from the registry once nothing is left in it.
 *
 * `kill(-pgid, 0)` is a syscall rather than a `ps` fork, so this is cheap
 * enough to run after every single command -- which is what keeps the
 * registry down to actual leaks instead of one entry per command, and keeps a
 * long-lived front-end (the ACP server) from accumulating stale pids.
 *
 * ESRCH means the group is empty. EPERM says nothing about membership -- it is
 * the host refusing group signals outright, which is what an OpenShell sandbox
 * does under seccomp -- so there the group is enumerated instead. That is the
 * case this has to be right in, since the sandbox is where a model is actually
 * turned loose.
 * @param {number|undefined} pgid
 * @param {number} psTimeoutMs
 */
function forgetEmptyGroup(pgid, psTimeoutMs) {
  if (!pgid) {
    return;
  }
  try {
    process.kill(-pgid, 0);
    return; // Still has members; keep it for the end-of-run sweep.
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'EPERM' && groupMemberPids(pgid, psTimeoutMs).length > 0) {
      return;
    }
  }
  detachedGroups.delete(pgid);
}

/**
 * Surviving members of the registered groups, bucketed by group.
 *
 * One `ps` call covers every group, rather than one per group: the registry is
 * normally empty or tiny, but a loop that leaked repeatedly should not turn
 * its own cleanup into a fork storm.
 * @param {number} psTimeoutMs
 * @returns {Map<number, number[]>}
 */
function survivorsByGroup(psTimeoutMs) {
  /** @type {Map<number, number[]>} */
  const byGroup = new Map();
  if (detachedGroups.size === 0) {
    return byGroup;
  }
  const rows = psRows('pid,pgid', psTimeoutMs);
  if (!rows) {
    return byGroup;
  }
  for (const [pid, pgid] of rows) {
    if (!detachedGroups.has(pgid) || pid === process.pid) {
      continue;
    }
    const members = byGroup.get(pgid) ?? [];
    members.push(pid);
    byGroup.set(pgid, members);
  }
  return byGroup;
}

/**
 * What a command left running: the groups that still have members, and every
 * surviving pid in them. Finds without killing, which is what --keep-orphans
 * needs -- the operator still hears about a leftover process, they just keep
 * it (see specs/orphan-sweep.yaml).
 * @param {number} [psTimeoutMs]
 * @returns {{ groups: number[], pids: number[] }}
 */
export function detachedSurvivors(psTimeoutMs = DEFAULT_PS_TIMEOUT_MS) {
  const byGroup = survivorsByGroup(psTimeoutMs);
  const pids = [];
  for (const members of byGroup.values()) {
    pids.push(...members);
  }
  return { groups: [...byGroup.keys()], pids };
}

/**
 * Forget every tracked group without touching the processes in it. For tests,
 * which share one process and would otherwise inherit each other's leaks.
 */
export function forgetDetachedGroups() {
  detachedGroups.clear();
}

/**
 * Reap whatever the run's commands left behind: SIGTERM every surviving group,
 * then SIGKILL anything still alive after graceMs.
 *
 * Only groups runShell created are ever touched -- never Kodr's own, whose
 * leader is the shell that launched us, so signalling it would take out the
 * operator's terminal. The safety argument is the one the timeout kill already
 * rests on: a group's id is its leader's pid, and the only process that can
 * have created a group whose id equals a pid we spawned is that child of ours.
 * @param {object} [options]
 * @param {number} [options.graceMs] - SIGTERM-to-SIGKILL delay
 * @param {number} [options.psTimeoutMs]
 * @returns {Promise<{ groups: number[], pids: number[], escalated: number[] }>}
 */
export async function sweepDetachedChildren(options = {}) {
  const psTimeoutMs = options.psTimeoutMs ?? DEFAULT_PS_TIMEOUT_MS;
  const graceMs = options.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const byGroup = survivorsByGroup(psTimeoutMs);
  detachedGroups.clear();
  const groups = [...byGroup.keys()];
  const pids = [];
  for (const members of byGroup.values()) {
    pids.push(...members);
  }
  if (pids.length === 0) {
    return { groups, pids, escalated: [] };
  }
  for (const [pgid, members] of byGroup) {
    killTree(pgid, members, 'SIGTERM', psTimeoutMs);
  }
  await delay(graceMs);
  const escalated = pids.filter(stillAlive);
  if (escalated.length > 0) {
    for (const [pgid, members] of byGroup) {
      killTree(pgid, members.filter(stillAlive), 'SIGKILL', psTimeoutMs);
    }
  }
  return { groups, pids, escalated };
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function stillAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal a timed-out command's whole process group, then its ppid-walked
 * descendants as a fallback.
 *
 * The group is what catches a backgrounded orphan. `sh -c "cargo run &"`
 * exits immediately, so the server is reparented to init and stops being a
 * descendant of anything we can name -- there is no moment at which a ppid
 * walk could have found it. It stays in the process group it inherited,
 * though, so the group signal still reaches it.
 *
 * The group kill is attempted, not relied on: a host that silently refuses to
 * put the child in its own group leaves no group whose id equals the child's
 * pid, so `kill(-pid)` throws ESRCH and the ppid walk still does the work
 * (the original reason this module avoided groups outright). It cannot hit
 * anything else by accident -- a process group's id is its leader's pid, and
 * the only process with that pid is our own child.
 * @param {number|undefined} pid - The direct child's pid
 * @param {number[]} pids - Its ppid-walked descendants
 * @param {NodeJS.Signals} signal
 */
function killTree(pid, pids, signal, psTimeoutMs = DEFAULT_PS_TIMEOUT_MS) {
  let groupSignalled = false;
  if (pid) {
    try {
      process.kill(-pid, signal);
      groupSignalled = true;
    } catch {
      // Either no such group (detached refused, or already gone) or the host
      // denies group signals outright -- EPERM inside an OpenShell sandbox.
      // Both are handled by enumerating the group below.
    }
  }
  if (!groupSignalled) {
    killPids(groupMemberPids(pid, psTimeoutMs), signal);
  }
  killPids(pids, signal);
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
  const rows = psRows('pid,ppid', psTimeoutMs);
  if (!rows) {
    return [rootPid];
  }

  const childrenByParent = new Map();
  for (const [pid, ppid] of rows) {
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

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated]`;
}
