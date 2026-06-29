import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadHooks,
  resolveHookTimeout,
  runStopHooks,
  stopHooks,
} from '../src/hooks.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-hooks-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeHooksConfig(content) {
  await mkdir(join(tmpDir, '.kodr'), { recursive: true });
  await writeFile(join(tmpDir, '.kodr', 'hooks.json'), content, 'utf8');
}

describe('loadHooks', () => {
  it('loads Stop hooks from .kodr/hooks.json', async () => {
    await writeHooksConfig(
      JSON.stringify({ hooks: { Stop: [{ run: 'npm run build' }] } }),
    );
    const { config, error } = await loadHooks(tmpDir);
    assert.equal(error, null);
    assert.deepEqual(config.hooks.Stop, [{ run: 'npm run build' }]);
  });

  it('yields no hooks and no error when the file is missing', async () => {
    const { config, error } = await loadHooks(tmpDir);
    assert.equal(error, null);
    assert.deepEqual(config.hooks, {});
  });

  it('returns an error value and no hooks when the file is malformed', async () => {
    await writeHooksConfig('{ not json');
    const { config, error } = await loadHooks(tmpDir);
    assert.match(error, /hooks\.json/);
    assert.deepEqual(config.hooks, {});
  });
});

describe('stopHooks', () => {
  it('appends --test as the first Stop hook', () => {
    const hooks = stopHooks({ hooks: {} }, 'npm test');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].run, 'npm test');
    assert.equal(hooks[0].name, 'test');
  });

  it('orders --test before configured Stop hooks', () => {
    const config = { hooks: { Stop: [{ run: 'npm run build' }] } };
    const hooks = stopHooks(config, 'npm test');
    assert.deepEqual(
      hooks.map((h) => h.run),
      ['npm test', 'npm run build'],
    );
  });

  it('drops invalid hook entries', () => {
    const config = {
      hooks: { Stop: [{ run: '' }, { name: 'x' }, { run: 'ok' }, 42] },
    };
    const hooks = stopHooks(config, null);
    assert.deepEqual(
      hooks.map((h) => h.run),
      ['ok'],
    );
  });

  it('defaults runWhenUnchanged to false', () => {
    const config = { hooks: { Stop: [{ run: 'ok' }] } };
    assert.equal(stopHooks(config, null)[0].runWhenUnchanged, false);
  });
});

describe('runStopHooks', () => {
  it('passes when every hook exits zero', async () => {
    const hooks = stopHooks({ hooks: { Stop: [{ run: 'exit 0' }] } }, null);
    const result = await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: true,
    });
    assert.equal(result.passed, true);
    assert.equal(result.results.length, 1);
  });

  it('runs hooks in declared order', async () => {
    const hooks = stopHooks(
      {
        hooks: {
          Stop: [
            { run: 'exit 0', name: 'a' },
            { run: 'exit 0', name: 'b' },
          ],
        },
      },
      null,
    );
    const result = await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: true,
    });
    assert.deepEqual(
      result.results.map((r) => r.name),
      ['a', 'b'],
    );
  });

  it('stops at the first failing blocking hook', async () => {
    const hooks = stopHooks(
      {
        hooks: {
          Stop: [
            { run: 'exit 3', name: 'first' },
            { run: 'exit 0', name: 'second' },
          ],
        },
      },
      null,
    );
    const result = await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].name, 'first');
  });

  it('feeds the failing hook output back through the aggregate', async () => {
    const hooks = stopHooks(
      { hooks: { Stop: [{ run: 'echo boom >&2; exit 1' }] } },
      null,
    );
    const result = await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: true,
    });
    assert.match(result.output, /boom/);
  });

  it('skips hooks when the workspace is untouched', async () => {
    const hooks = stopHooks({ hooks: { Stop: [{ run: 'exit 1' }] } }, null);
    const result = await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: false,
    });
    assert.equal(result.passed, true);
    assert.equal(result.results.length, 0);
  });

  it('runs runWhenUnchanged hooks even when untouched', async () => {
    const hooks = stopHooks(
      { hooks: { Stop: [{ run: 'exit 0', runWhenUnchanged: true }] } },
      null,
    );
    const result = await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: false,
    });
    assert.equal(result.results.length, 1);
  });

  it('caps a hook timeout by the remaining run budget', async () => {
    const command = `${process.execPath} -e "setTimeout(() => {}, 1000)"`;
    const hooks = stopHooks({ hooks: { Stop: [{ run: command }] } }, null);
    const result = await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: true,
      budgetMs: 20,
    });
    assert.equal(result.passed, false);
  });
});

describe('resolveHookTimeout', () => {
  it('returns undefined when neither is set', () => {
    assert.equal(resolveHookTimeout(undefined, undefined), undefined);
  });

  it('returns the hook timeout when only it is set', () => {
    assert.equal(resolveHookTimeout(5000, undefined), 5000);
  });

  it('returns the budget when only it is set', () => {
    assert.equal(resolveHookTimeout(undefined, 3000), 3000);
  });

  it('returns the smaller of the two', () => {
    assert.equal(resolveHookTimeout(5000, 3000), 3000);
    assert.equal(resolveHookTimeout(2000, 3000), 2000);
  });
});
