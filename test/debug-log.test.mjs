import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDebugLogger, debugLogEnabled } from '../src/debug-log.mjs';

describe('debugLogEnabled', () => {
  const envKey = 'KODR_DEBUG';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('is off by default', () => {
    delete process.env[envKey];
    assert.equal(debugLogEnabled(undefined), false);
  });

  it('is on when the option is true', () => {
    delete process.env[envKey];
    assert.equal(debugLogEnabled(true), true);
  });

  it('is on via KODR_DEBUG', () => {
    process.env[envKey] = '1';
    assert.equal(debugLogEnabled(undefined), true);
  });

  it('the option takes precedence over KODR_DEBUG when explicitly set to false', () => {
    process.env[envKey] = '1';
    assert.equal(debugLogEnabled(false), false);
  });
});

describe('createDebugLogger', () => {
  let runsDir;

  afterEach(async () => {
    if (runsDir) {
      await rm(runsDir, { recursive: true, force: true });
      runsDir = undefined;
    }
  });

  it('appends one JSON line per call with the given record fields', async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'kodr-debug-log-'));
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const onDebug = createDebugLogger(runsDir, startedAt);

    onDebug({
      url: 'http://x/v1/chat/completions',
      requestBody: { a: 1 },
      rawResponse: 'data: ok',
    });
    await flush(onDebug);

    const files = await readdir(runsDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^2026-01-01T00-00-00-000Z-debug\.jsonl$/);

    const content = await readFile(join(runsDir, files[0]), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.url, 'http://x/v1/chat/completions');
    assert.deepEqual(record.requestBody, { a: 1 });
    assert.equal(record.rawResponse, 'data: ok');
    assert.ok(record.timestamp);
  });

  it('appends a distinct line for each of several calls, preserving order', async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'kodr-debug-log-'));
    const onDebug = createDebugLogger(runsDir, new Date());

    onDebug({ rawResponse: 'first' });
    onDebug({ rawResponse: 'second' });
    onDebug({ rawResponse: 'third' });
    await flush(onDebug);

    const files = await readdir(runsDir);
    const content = await readFile(join(runsDir, files[0]), 'utf8');
    const records = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((r) => r.rawResponse),
      ['first', 'second', 'third'],
    );
  });

  it('creates the runs directory if it does not already exist', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kodr-debug-log-parent-'));
    runsDir = join(parent, 'nested', 'runs');
    const onDebug = createDebugLogger(runsDir, new Date());

    onDebug({ rawResponse: 'ok' });
    await flush(onDebug);

    const files = await readdir(runsDir);
    assert.equal(files.length, 1);
  });

  it("does not throw or reject when the appender's write fails", async () => {
    // Point runsDir at a path where a *file* already exists -- mkdir(recursive)
    // over an existing file fails, and every subsequent appendFile call fails too.
    const parent = await mkdtemp(join(tmpdir(), 'kodr-debug-log-blocked-'));
    const blockedPath = join(parent, 'blocked');
    await writeFile(blockedPath, 'not a directory', 'utf8');
    runsDir = blockedPath;

    const onDebug = createDebugLogger(join(blockedPath, 'runs'), new Date());
    assert.doesNotThrow(() => onDebug({ rawResponse: 'never written' }));
    await flush(onDebug);
    // No unhandled rejection reached this point -- node:test would report one.
  });
});

// createDebugLogger's writes are chained internally with no way to await
// them from the caller (onDebug is fire-and-forget by design) -- give the
// real fs I/O a moment to land before assertions.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}
