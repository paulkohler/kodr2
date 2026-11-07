import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runShell } from '../src/shell.mjs';

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-shell-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('runShell', () => {
  it('returns exit code 0 for a successful command', async () => {
    const result = await runShell('exit 0', tmpDir);
    assert.equal(result.exitCode, 0);
  });

  it('reports the process exit code on failure', async () => {
    const result = await runShell('exit 7', tmpDir);
    assert.equal(result.exitCode, 7);
  });

  it('captures stdout and stderr separately', async () => {
    const result = await runShell('echo out; echo err >&2', tmpDir);
    assert.match(result.stdout, /out/);
    assert.match(result.stderr, /err/);
  });

  it('truncates long output and marks it', async () => {
    const result = await runShell(
      `${process.execPath} -e "process.stdout.write('x'.repeat(200))"`,
      tmpDir,
      { maxOutput: 100 },
    );
    assert.ok(result.stdout.length <= 112);
    assert.match(result.stdout, /\[truncated\]/);
  });

  it('reports a non-zero exit code when a command times out', async () => {
    const result = await runShell(
      `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      tmpDir,
      { timeout: 20 },
    );
    assert.notEqual(result.exitCode, 0);
  });

  it('kills grandchild processes on timeout, not just the shell', async () => {
    // Simulates `npm test` spawning a `node --test` grandchild that hangs on
    // a stray interval: the direct child (standing in for npm) stays alive
    // the whole time, and the grandchild ignores SIGTERM (as an un-refed
    // interval effectively does -- the process just never exits on its
    // own). A timeout that only signals the direct child would resolve
    // runShell but leave this orphaned and running forever.
    const markerFile = join(tmpDir, 'grandchild.pid');
    const parentScript = join(tmpDir, 'parent.mjs');
    await writeFile(
      parentScript,
      `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
      writeFileSync(process.argv[2], String(child.pid));
      setInterval(() => {}, 1000);
      `,
    );

    // Generous timeout: under heavy parallel load (many test files
    // spawning subprocesses at once), even the parent script's own node
    // startup + spawn() + writeFileSync can take longer than a tight
    // timeout budget, which would kill the tree before the marker file is
    // ever written -- a false setup failure, not a real assertion result.
    await runShell(
      `${process.execPath} ${parentScript} ${markerFile}`,
      tmpDir,
      { timeout: 500, killGraceMs: 200 },
    );

    const grandchildPid = Number(await readFile(markerFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      isProcessAlive(grandchildPid),
      false,
      'grandchild process should have been killed along with the rest of the command tree',
    );
  });

  it('calls onHeartbeat on an interval while a command runs', async () => {
    const ticks = [];
    await runShell(
      `${process.execPath} -e "setTimeout(() => {}, 120)"`,
      tmpDir,
      { heartbeatMs: 30, onHeartbeat: (elapsedMs) => ticks.push(elapsedMs) },
    );
    assert.ok(
      ticks.length >= 2,
      `expected multiple ticks, got ${ticks.length}`,
    );
  });

  it('does not call onHeartbeat when heartbeatMs is 0', async () => {
    const ticks = [];
    await runShell('exit 0', tmpDir, {
      heartbeatMs: 0,
      onHeartbeat: (elapsedMs) => ticks.push(elapsedMs),
    });
    assert.equal(ticks.length, 0);
  });

  it('stops calling onHeartbeat once the command finishes', async () => {
    const ticks = [];
    await runShell('exit 0', tmpDir, {
      heartbeatMs: 10,
      onHeartbeat: (elapsedMs) => ticks.push(elapsedMs),
    });
    const countAfterFinish = ticks.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ticks.length, countAfterFinish);
  });
});

describe('runShell timeout with a backgrounded command', () => {
  it('honours the timeout when an orphan holds the pipes open', async () => {
    // BACKLOG #9 / the bug this guards: `sh -c "sleep 30 &"` exits at once,
    // but the backgrounded child inherits stdout/stderr, so execFile's
    // callback never fires -- and because sh is gone the orphan has been
    // reparented to init, so the ppid walk finds nothing to kill. Before the
    // fix this pended for the full 30s (a model-issued `cargo run &` pended
    // ~7 minutes against a 180s timeout); now the timeout answers.
    // A short sleep keeps the suite fast: the orphan's open pipes hold
    // node's handle open until it exits, which is the leak BACKLOG #9 covers.
    const started = Date.now();
    const result = await runShell('sleep 2 &', process.cwd(), {
      timeout: 300,
      killGraceMs: 50,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /timed out after 300ms/);
    assert.ok(
      elapsed < 5000,
      `should resolve on the timeout, not wait for the orphan (took ${elapsed}ms)`,
    );
  });

  it('still reports a foreground command that overruns', async () => {
    const result = await runShell('sleep 30', process.cwd(), {
      timeout: 300,
      killGraceMs: 50,
    });
    assert.equal(result.exitCode, 1);
  });
});

describe('runShell reaps a backgrounded orphan (BACKLOG #9)', () => {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  it('kills a backgrounded process the ppid walk cannot see', async () => {
    // The orphan is reparented to init the moment `sh` exits, so no ppid walk
    // can find it. It stays in the process group it inherited, which is what
    // the group kill reaches. If the kill fails, the marker appears.
    const { mkdtemp } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kodr-orphan-'));
    const marker = join(dir, 'MARKER');

    const result = await runShell(`(sleep 1; touch ${marker}) &`, dir, {
      timeout: 200,
      killGraceMs: 50,
    });
    assert.equal(result.exitCode, 1);

    // Wait past when the orphan would have written, had it survived.
    await settle(1600);
    assert.equal(
      existsSync(marker),
      false,
      'the backgrounded process should have been killed with its group',
    );
  });

  it('cancels on an AbortSignal and kills the group with it', async () => {
    // Ctrl-C has to be forwarded explicitly: a detached child is in its own
    // process group, so the terminal's SIGINT no longer reaches it.
    const { mkdtemp } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kodr-cancel-'));
    const marker = join(dir, 'MARKER');

    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);
    const result = await runShell(`(sleep 1; touch ${marker}) &`, dir, {
      timeout: 60000,
      killGraceMs: 50,
      signal: controller.signal,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /cancelled/);
    assert.ok(elapsed < 5000, `should answer on abort (took ${elapsed}ms)`);
    await settle(1600);
    assert.equal(existsSync(marker), false, 'abort should kill the group too');
  });

  it('answers at once when the signal is already aborted', async () => {
    const result = await runShell('sleep 30', process.cwd(), {
      timeout: 60000,
      signal: AbortSignal.abort(),
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /cancelled/);
  });
});
