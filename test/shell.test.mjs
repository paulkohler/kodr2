import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runShell } from '../src/shell.mjs';

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

  it('calls onHeartbeat on an interval while a command runs', async () => {
    const ticks = [];
    await runShell(
      `${process.execPath} -e "setTimeout(() => {}, 120)"`,
      tmpDir,
      { heartbeatMs: 30, onHeartbeat: (elapsedMs) => ticks.push(elapsedMs) },
    );
    assert.ok(ticks.length >= 2, `expected multiple ticks, got ${ticks.length}`);
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
