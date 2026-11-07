/**
 * BACKLOG #11: a command that *succeeds* having detached a child was reaped by
 * nothing. killTree only ever ran from inside runShell, on output overflow,
 * timeout and abort -- and `node server.mjs > /dev/null 2>&1 &` trips none of
 * them, because the redirect closes the pipes so `sh` exits 0 at once.
 *
 * These drive real processes on purpose. The bug was that nothing in the
 * harness looked at the OS process table after a command returned, so a test
 * that faked the process table would have passed against the broken code.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  keepOrphansEnabled,
  main,
  parseArgs,
  reapLeftoverChildren,
  sweepGraceMs,
} from '../src/cli.mjs';
import {
  DEFAULT_SWEEP_GRACE_MS,
  detachedSurvivors,
  forgetDetachedGroups,
  runShell,
  sweepDetachedChildren,
} from '../src/shell.mjs';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a predicate rather than sleeping a guessed interval. */
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

let tmpDir;
/** Every pid a test started, so a failure can never leak one past the suite. */
let started;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-sweep-'));
  started = [];
  // Tests share one process, so a leak from an earlier test would otherwise
  // show up as a survivor here.
  forgetDetachedGroups();
});

afterEach(async () => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already reaped, which is the point of most of these tests.
    }
  }
  forgetDetachedGroups();
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Start a long-lived child the way a model does it: backgrounded with its
 * output redirected, so `sh` exits 0 immediately and no timeout ever fires.
 * @param {object} [options]
 * @param {boolean} [options.ignoreSigterm]
 * @returns {Promise<number>} the child's pid
 */
async function leakChild(options = {}) {
  const pidFile = join(tmpDir, `pid-${started.length}.txt`);
  const trap = options.ignoreSigterm ? "process.on('SIGTERM', () => {});" : '';
  await writeFile(
    join(tmpDir, 'child.mjs'),
    `import { writeFileSync } from 'node:fs';
${trap}
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const result = await runShell(
    `${process.execPath} child.mjs > /dev/null 2>&1 &`,
    tmpDir,
    { timeout: 10_000 },
  );
  // Exit 0 and no timeout is the whole premise of the bug.
  assert.equal(result.exitCode, 0);
  const { readFileSync, existsSync } = await import('node:fs');
  const wrote = await until(() => existsSync(pidFile));
  assert.ok(wrote, 'the backgrounded child never wrote its pid');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  started.push(pid);
  return pid;
}

describe('end-of-run sweep (BACKLOG #11)', () => {
  it('reaps a child a successful command detached', async () => {
    const pid = await leakChild();
    assert.ok(isAlive(pid), 'the child should outlive the command itself');

    const swept = await sweepDetachedChildren({ graceMs: 100 });

    assert.ok(swept.pids.includes(pid));
    assert.ok(await until(() => !isAlive(pid)), 'the child was not reaped');
  });

  it('reports the pids it killed', async () => {
    const pid = await leakChild();
    const lines = [];

    // A short grace keeps the suite fast; the default 2s is for a real exit.
    await reapLeftoverChildren(parseArgs(['--sweep-grace-ms', '100']), {
      write: (text) => lines.push(text),
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^kodr: killed 1 process \(pid \d+\)/);
    assert.match(lines[0], new RegExp(String(pid)));
  });

  it('sweeps nothing, and waits for nothing, when a run left nothing behind', async () => {
    await runShell('echo hi', tmpDir);
    const startedAt = Date.now();

    // A grace long enough that paying it would be obvious.
    const swept = await sweepDetachedChildren({ graceMs: 10_000 });

    assert.deepEqual(swept.pids, []);
    assert.deepEqual(swept.groups, []);
    assert.ok(
      Date.now() - startedAt < 1000,
      'a clean run must not pay the SIGTERM/SIGKILL grace to exit',
    );
  });

  it('forgets a group whose command exited cleanly, rather than reporting it', async () => {
    await runShell('echo hi; true', tmpDir);
    assert.deepEqual(detachedSurvivors().pids, []);
  });

  it("never reports Kodr's own pid as a survivor", async () => {
    await leakChild();
    const found = detachedSurvivors();
    assert.ok(found.pids.length > 0, 'the fixture should have leaked');
    assert.ok(!found.pids.includes(process.pid));
  });

  it('escalates to SIGKILL a survivor that ignores SIGTERM', async () => {
    const pid = await leakChild({ ignoreSigterm: true });

    const swept = await sweepDetachedChildren({ graceMs: 250 });

    assert.ok(swept.escalated.includes(pid), 'should have needed a SIGKILL');
    assert.ok(await until(() => !isAlive(pid)), 'SIGKILL did not land');
  });

  it('leaves survivors running under keepOrphans, and still reports them', async () => {
    const pid = await leakChild();
    const lines = [];

    await reapLeftoverChildren(parseArgs(['--keep-orphans']), {
      write: (text) => lines.push(text),
    });

    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /left running by a command -- kept \(--keep-orphans\)/,
    );
    assert.match(lines[0], new RegExp(String(pid)));
    assert.ok(isAlive(pid), 'keepOrphans must not kill it');
  });

  it('reports nothing at all when nothing was left behind', async () => {
    await runShell('echo hi', tmpDir);
    const lines = [];

    await reapLeftoverChildren(parseArgs([]), {
      write: (text) => lines.push(text),
    });

    assert.deepEqual(lines, []);
  });
});

describe('main wraps the sweep around the whole dispatch', () => {
  it('reaps a leftover child after the dispatched command finishes', async () => {
    const pid = await leakChild();

    await main(['--sweep-grace-ms', '100'], { dispatch: async () => {} });

    assert.ok(await until(() => !isAlive(pid)), 'main did not reap the child');
  });

  it('reaps a leftover child even when the dispatched command throws', async () => {
    const pid = await leakChild();

    await assert.rejects(
      main(['--sweep-grace-ms', '100'], {
        dispatch: async () => {
          throw new Error('boom');
        },
      }),
      /boom/,
    );

    assert.ok(
      await until(() => !isAlive(pid)),
      'a run that threw is exactly when something is most likely still running',
    );
  });
});

describe('sweepGraceMs', () => {
  const saved = process.env.KODR_SWEEP_GRACE_MS;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KODR_SWEEP_GRACE_MS;
      return;
    }
    process.env.KODR_SWEEP_GRACE_MS = saved;
  });

  it('prefers the flag over the env var', () => {
    process.env.KODR_SWEEP_GRACE_MS = '999';
    assert.equal(sweepGraceMs(parseArgs(['--sweep-grace-ms', '42'])), 42);
  });

  it('falls back to the env var', () => {
    process.env.KODR_SWEEP_GRACE_MS = '999';
    assert.equal(sweepGraceMs(parseArgs([])), 999);
  });

  it('falls back to the default', () => {
    delete process.env.KODR_SWEEP_GRACE_MS;
    assert.equal(sweepGraceMs(parseArgs([])), DEFAULT_SWEEP_GRACE_MS);
  });

  it('ignores a non-numeric or negative value rather than turning the escalation into an immediate SIGKILL', () => {
    process.env.KODR_SWEEP_GRACE_MS = 'soon';
    assert.equal(sweepGraceMs(parseArgs([])), DEFAULT_SWEEP_GRACE_MS);
    process.env.KODR_SWEEP_GRACE_MS = '-5';
    assert.equal(sweepGraceMs(parseArgs([])), DEFAULT_SWEEP_GRACE_MS);
  });

  it('accepts zero, which means escalate at once', () => {
    assert.equal(sweepGraceMs(parseArgs(['--sweep-grace-ms', '0'])), 0);
  });
});

describe('keepOrphansEnabled', () => {
  const saved = process.env.KODR_KEEP_ORPHANS;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KODR_KEEP_ORPHANS;
      return;
    }
    process.env.KODR_KEEP_ORPHANS = saved;
  });

  it('is off by default', () => {
    delete process.env.KODR_KEEP_ORPHANS;
    assert.equal(keepOrphansEnabled(parseArgs([])), false);
  });

  it('is on with the flag', () => {
    delete process.env.KODR_KEEP_ORPHANS;
    assert.equal(keepOrphansEnabled(parseArgs(['--keep-orphans'])), true);
  });

  it('is on with the env var', () => {
    process.env.KODR_KEEP_ORPHANS = '1';
    assert.equal(keepOrphansEnabled(parseArgs([])), true);
    process.env.KODR_KEEP_ORPHANS = 'true';
    assert.equal(keepOrphansEnabled(parseArgs([])), true);
  });

  it('ignores any other env value', () => {
    process.env.KODR_KEEP_ORPHANS = 'yes';
    assert.equal(keepOrphansEnabled(parseArgs([])), false);
  });
});
