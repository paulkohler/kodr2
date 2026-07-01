import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  hookMatches,
  loadHooks,
  resolveHookTimeout,
  runPostToolHooks,
  runPreToolHooks,
  runSessionHooks,
  runStopHooks,
  sessionHooks,
  stopHooks,
  toolHooks,
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

  it('reports heartbeats tagged with the hook name while it runs', async () => {
    const hooks = stopHooks(
      {
        hooks: {
          Stop: [
            {
              run: `${process.execPath} -e "setTimeout(() => {}, 120)"`,
              name: 'slow',
            },
          ],
        },
      },
      null,
    );
    const ticks = [];
    await runStopHooks(hooks, tmpDir, {
      touchedWorkspace: true,
      heartbeatMs: 30,
      onHeartbeat: (name, elapsedMs) => ticks.push({ name, elapsedMs }),
    });
    assert.ok(ticks.length >= 2, `expected multiple ticks, got ${ticks.length}`);
    assert.ok(ticks.every((t) => t.name === 'slow'));
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

describe('toolHooks', () => {
  it('parses run, match, and timeout, dropping invalid entries', () => {
    const config = {
      hooks: {
        PreToolUse: [
          { run: 'a', match: 'run_command', timeout: 5000 },
          { name: 'no-run' },
          { run: 'b' },
        ],
      },
    };
    const hooks = toolHooks(config, 'PreToolUse');
    assert.deepEqual(hooks, [
      { run: 'a', name: 'a', match: 'run_command', timeout: 5000 },
      { run: 'b', name: 'b' },
    ]);
  });

  it('returns an empty list for an absent event', () => {
    assert.deepEqual(toolHooks({ hooks: {} }, 'PostToolUse'), []);
  });
});

describe('hookMatches', () => {
  it('matches every tool when no match is set', () => {
    assert.equal(hookMatches({}, 'anything'), true);
  });

  it('applies the match regex to the tool name', () => {
    assert.equal(
      hookMatches({ match: 'write_file|edit_file' }, 'edit_file'),
      true,
    );
    assert.equal(hookMatches({ match: 'write_file' }, 'read_file'), false);
  });

  it('never matches when the regex is invalid', () => {
    assert.equal(hookMatches({ match: '(' }, 'read_file'), false);
  });
});

describe('runPreToolHooks', () => {
  const call = { name: 'run_command', args: { command: 'rm -rf /' } };

  it('lets the call proceed when all matching hooks pass', async () => {
    const hooks = toolHooks(
      { hooks: { PreToolUse: [{ run: 'exit 0' }] } },
      'PreToolUse',
    );
    const result = await runPreToolHooks(hooks, call, tmpDir);
    assert.equal(result.denied, false);
  });

  it('denies the call on the first failing hook', async () => {
    const hooks = toolHooks(
      {
        hooks: {
          PreToolUse: [{ run: 'echo nope >&2; exit 1', name: 'policy' }],
        },
      },
      'PreToolUse',
    );
    const result = await runPreToolHooks(hooks, call, tmpDir);
    assert.equal(result.denied, true);
    assert.match(result.reason, /PreToolUse hook "policy"/);
    assert.match(result.reason, /nope/);
  });

  it('skips hooks whose match does not apply', async () => {
    const hooks = toolHooks(
      { hooks: { PreToolUse: [{ run: 'exit 1', match: 'write_file' }] } },
      'PreToolUse',
    );
    const result = await runPreToolHooks(hooks, call, tmpDir);
    assert.equal(result.denied, false);
  });

  it('exposes the tool name, args, and file in the hook env', async () => {
    const hooks = toolHooks(
      {
        hooks: {
          PreToolUse: [
            {
              run: '[ "$KODR_TOOL_NAME" = "write_file" ] && [ "$KODR_TOOL_FILE" = "a.txt" ] && echo "$KODR_TOOL_ARGS" | grep -q hello',
            },
          ],
        },
      },
      'PreToolUse',
    );
    const writeCall = {
      name: 'write_file',
      args: { path: 'a.txt', content: 'hello' },
    };
    const result = await runPreToolHooks(hooks, writeCall, tmpDir);
    assert.equal(result.denied, false);
  });
});

describe('runPostToolHooks', () => {
  const call = { name: 'write_file', args: { path: 'a.txt' } };

  it('returns no feedback when every hook passes', async () => {
    const hooks = toolHooks(
      { hooks: { PostToolUse: [{ run: 'exit 0' }] } },
      'PostToolUse',
    );
    const result = await runPostToolHooks(hooks, call, { ok: true }, tmpDir);
    assert.equal(result.feedback, '');
  });

  it('collects feedback from every failing hook', async () => {
    const hooks = toolHooks(
      {
        hooks: {
          PostToolUse: [
            { run: 'echo first >&2; exit 1', name: 'one' },
            { run: 'echo second >&2; exit 1', name: 'two' },
          ],
        },
      },
      'PostToolUse',
    );
    const result = await runPostToolHooks(hooks, call, { ok: true }, tmpDir);
    assert.match(result.feedback, /hook "one" failed/);
    assert.match(result.feedback, /hook "two" failed/);
  });

  it('exposes the tool result in the hook env', async () => {
    const hooks = toolHooks(
      {
        hooks: {
          PostToolUse: [
            {
              run: 'echo "$KODR_TOOL_RESULT" | grep -q written || (echo missing >&2; exit 1)',
            },
          ],
        },
      },
      'PostToolUse',
    );
    const result = await runPostToolHooks(
      hooks,
      call,
      { status: 'written' },
      tmpDir,
    );
    assert.equal(result.feedback, '');
  });
});

describe('sessionHooks', () => {
  it('parses run, name, and timeout, dropping invalid entries', () => {
    const config = {
      hooks: {
        SessionStart: [
          { run: 'a', name: 'first', timeout: 5000 },
          { name: 'no-run' },
          { run: 'b' },
        ],
      },
    };
    assert.deepEqual(sessionHooks(config, 'SessionStart'), [
      { run: 'a', name: 'first', timeout: 5000 },
      { run: 'b', name: 'b' },
    ]);
  });

  it('returns an empty list for an absent event', () => {
    assert.deepEqual(sessionHooks({ hooks: {} }, 'SessionEnd'), []);
  });
});

describe('runSessionHooks', () => {
  it('returns hook stdout as injectable context', async () => {
    const hooks = sessionHooks(
      { hooks: { SessionStart: [{ run: 'echo hello-context', name: 'ctx' }] } },
      'SessionStart',
    );
    const { context, failures } = await runSessionHooks(hooks, tmpDir);
    assert.equal(failures.length, 0);
    assert.equal(context.length, 1);
    assert.equal(context[0].name, 'ctx');
    assert.match(context[0].output, /hello-context/);
  });

  it('reports a failing hook as a failure, not context', async () => {
    const hooks = sessionHooks(
      {
        hooks: {
          SessionStart: [{ run: 'echo boom >&2; exit 1', name: 'bad' }],
        },
      },
      'SessionStart',
    );
    const { context, failures } = await runSessionHooks(hooks, tmpDir);
    assert.equal(context.length, 0);
    assert.equal(failures.length, 1);
    assert.match(failures[0].output, /boom/);
  });

  it('runs SessionEnd hooks for their side effects', async () => {
    await writeFile(join(tmpDir, 'marker.txt'), 'x');
    const hooks = sessionHooks(
      { hooks: { SessionEnd: [{ run: 'rm marker.txt', name: 'cleanup' }] } },
      'SessionEnd',
    );
    const { failures } = await runSessionHooks(hooks, tmpDir);
    assert.equal(failures.length, 0);
    await assert.rejects(() => readFile(join(tmpDir, 'marker.txt')));
  });
});
