import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import {
  commitSubjects,
  createLoopRepo,
  readRepoFile,
} from './loop-fixtures.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  for (const kind of ['plain', 'goal']) {
    for (const mode of ['in-flight', 'backoff']) {
      it(`${signal} during ${kind} ${mode} saves cancellation and reaps orphans`, {
        timeout: 10_000,
      }, async (t) => {
        let task = 'alpha';
        if (kind === 'goal') {
          task = 'GOAL: alpha';
        }
        const ctx = await createLoopRepo({ tasks: [task, 'beta'] });
        const child = fork(
          new URL('./fixtures/signal-loop.mjs', import.meta.url),
          [ctx.repo, kind, mode],
          {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env, KODR_KEEP_ORPHANS: '0' },
          },
        );
        let orphanPid;
        let stderr = '';
        let stdout = '';
        child.stderr.setEncoding('utf8').on('data', (text) => {
          stderr += text;
        });
        child.stdout.setEncoding('utf8').on('data', (text) => {
          stdout += text;
        });
        t.after(async () => {
          child.kill('SIGKILL');
          if (orphanPid && alive(orphanPid)) {
            process.kill(orphanPid, 'SIGKILL');
          }
          await ctx.cleanup();
        });
        const exited = once(child, 'exit');
        const closed = once(child, 'close');
        const message = await Promise.race([
          once(child, 'message').then(([value]) => value),
          exited.then(() => {
            throw new Error(`driver exited before readiness: ${stderr}`);
          }),
        ]);
        orphanPid = message.orphanPid;
        assert.equal(
          alive(orphanPid),
          true,
          'the detached child must really exist',
        );
        child.kill(/** @type {NodeJS.Signals} */ (signal));
        const [code, killedBy] = await closed;
        assert.equal(killedBy, null, stderr);
        assert.equal(code, 1, stderr);
        const result = JSON.parse(stdout);
        const record = JSON.parse(
          readRepoFile(ctx.repo, '.kodr/loops/signal.json'),
        );
        assert.equal(result.reason, 'cancelled');
        assert.equal(record.reason, 'cancelled');
        assert.equal(record.tasks.length, 1);
        assert.equal(record.tasks[0].status, 'cancelled');
        assert.equal(record.tasks[0].attempts, 1);
        assert.equal(record.usage.prompt, 10);
        assert.equal(
          readRepoFile(ctx.repo, 'TASKS.md'),
          `# Tasks\n\n- [ ] ${task}\n- [ ] beta\n`,
        );
        assert.equal(
          readRepoFile(ctx.repo, 'partial.mjs'),
          'export const partial = true;\n',
        );
        assert.deepEqual(commitSubjects(ctx.repo), ['init']);
        assert.match(stderr, /kodr: killed .*left running by a command/);
        assert.equal(alive(orphanPid), false, `orphan ${orphanPid} survived`);
      });
    }
  }
}
