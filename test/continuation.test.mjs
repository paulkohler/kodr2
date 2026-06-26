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
    await writeRun(join(runDir, '2026-01.json'), 'old');
    await writeRun(join(runDir, '2026-02.json'), 'new');

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
});

async function writeRun(path, content) {
  const data = {
    messages: [
      { role: 'system', content: 'stale' },
      { role: 'user', content },
    ],
  };
  await writeFile(path, JSON.stringify(data));
}
