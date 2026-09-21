import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadPriorRun } from '../src/cli.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-continuation-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadPriorRun', () => {
  it('loads the latest run and strips system messages', async () => {
    const runDir = join(tmpDir, '.kodr', 'runs');
    await mkdir(runDir, { recursive: true });
    await writeRun(join(runDir, '2026-01-01T00-00-00-000Z.json'), 'old');
    await writeRun(
      join(runDir, '2026-02-01T00-00-00-000Z-1234abcd.json'),
      'new',
    );

    const result = await loadPriorRun(tmpDir, 'last');
    assert.deepEqual(result.messages, [{ role: 'user', content: 'new' }]);
  });

  it('resolves a specific run relative to the workspace', async () => {
    await writeRun(join(tmpDir, 'run.json'), 'relative');
    const result = await loadPriorRun(tmpDir, 'run.json');
    assert.equal(result.messages[0].content, 'relative');
  });

  it('returns null when no run exists', async () => {
    assert.equal(await loadPriorRun(tmpDir, 'last'), null);
  });

  it('ignores newer incident and heartbeat records when resolving last', async () => {
    const runDir = join(tmpDir, '.kodr', 'runs');
    await mkdir(runDir, { recursive: true });
    await writeRun(join(runDir, '2026-01-01T00-00-00-000Z.json'), 'real run');
    await writeFile(
      join(runDir, '2026-12-01T00-00-00-000Z-deadbeef.incident.json'),
      JSON.stringify({ type: 'uncaughtException' }),
    );
    await writeFile(
      join(runDir, '.heartbeat-123.json'),
      JSON.stringify({ pid: 123 }),
    );

    const result = await loadPriorRun(tmpDir, 'last');

    assert.equal(result.messages[0].content, 'real run');
  });

  it('returns null when only non-run JSON records exist', async () => {
    const runDir = join(tmpDir, '.kodr', 'runs');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, '2026-12-01T00-00-00-000Z-deadbeef.incident.json'),
      JSON.stringify({ type: 'uncaughtException' }),
    );
    await writeFile(
      join(runDir, '.heartbeat-123.json'),
      JSON.stringify({ pid: 123 }),
    );

    assert.equal(await loadPriorRun(tmpDir, 'last'), null);
  });

  it('returns null for an explicit JSON record with no messages array', async () => {
    await writeFile(
      join(tmpDir, 'incident.json'),
      JSON.stringify({ type: 'uncaughtException' }),
    );

    assert.equal(await loadPriorRun(tmpDir, 'incident.json'), null);
  });

  it('drops a dangling trailing assistant tool call', async () => {
    const path = join(tmpDir, 'dangling.json');
    await writeRecord(path, [
      { role: 'user', content: 'do work' },
      assistantCalls('call-1'),
    ]);

    const result = await loadPriorRun(tmpDir, 'dangling.json');

    assert.deepEqual(result.messages, [{ role: 'user', content: 'do work' }]);
  });

  it('drops an incomplete multi-call group with its partial results', async () => {
    const path = join(tmpDir, 'partial.json');
    await writeRecord(path, [
      { role: 'user', content: 'do work' },
      assistantCalls('call-1', 'call-2'),
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    ]);

    const result = await loadPriorRun(tmpDir, 'partial.json');

    assert.deepEqual(result.messages, [{ role: 'user', content: 'do work' }]);
  });

  it('preserves a complete assistant tool-call group and its results', async () => {
    const path = join(tmpDir, 'complete.json');
    const messages = [
      { role: 'user', content: 'do work' },
      assistantCalls('call-1', 'call-2'),
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'call-2', content: '{"ok":true}' },
    ];
    await writeRecord(path, messages);

    const result = await loadPriorRun(tmpDir, 'complete.json');

    assert.deepEqual(result.messages, messages);
  });
});

async function writeRun(path, content) {
  await writeRecord(path, [
    { role: 'system', content: 'stale' },
    { role: 'user', content },
  ]);
}

async function writeRecord(path, messages) {
  await writeFile(path, JSON.stringify({ messages }));
}

function assistantCalls(...ids) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: ids.map((id) => ({
      id,
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    })),
  };
}
