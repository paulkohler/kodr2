import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { verify } from '../src/verify.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-verify-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('verify', () => {
  it('returns passed true for a successful command', async () => {
    const result = await verify('exit 0', tmpDir);
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
  });

  it('returns passed false for a failing command', async () => {
    const result = await verify('exit 7', tmpDir);
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 7);
  });

  it('captures combined stdout and stderr', async () => {
    const result = await verify('echo output; echo error >&2', tmpDir);
    assert.match(result.output, /output/);
    assert.match(result.output, /error/);
  });

  it('truncates output', async () => {
    const command = `${process.execPath} -e "process.stdout.write('x'.repeat(200))"`;
    const result = await verify(command, tmpDir, { maxOutput: 100 });
    assert.equal(result.output.length, 100);
  });

  it('fails commands that time out', async () => {
    const command = `${process.execPath} -e "setTimeout(() => {}, 1000)"`;
    const result = await verify(command, tmpDir, { timeout: 20 });
    assert.equal(result.passed, false);
    assert.notEqual(result.exitCode, 0);
  });
});
