import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runShell } from '../src/shell.mjs';

// A killed process can linger as an unreaped zombie when PID 1 is not a
// reaping init (as in some containers). process.kill(pid, 0) still succeeds
// for a zombie, but the process is dead -- so a 'Z' state counts as not alive.
// A still-running process (kill mechanism failed) is state R/S, not Z, so the
// timeout-kill assertions still catch a real regression.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}

function isZombie(pid) {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])
      .toString()
      .trim();
    return stat.startsWith('Z');
  } catch {
    // No such process (already reaped/gone): not alive, and not a zombie.
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
