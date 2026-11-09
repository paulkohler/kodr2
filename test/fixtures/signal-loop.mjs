// A subprocess driver for real OS signals, without a model or network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCancellationHandlers, main } from '../../src/cli.mjs';
import { runGoal } from '../../src/goal.mjs';
import { runLoop } from '../../src/loop.mjs';
import { checklistAdapter, gitAdapter } from '../../src/loop-adapters.mjs';
import { writeLoopRecord } from '../../src/loop-record.mjs';
import { createNullReporter } from '../../src/reporter.mjs';
import { runShell } from '../../src/shell.mjs';

const [repo, _kind, mode] = process.argv.slice(2);
const controller = new AbortController();
let orphanPid;

function ready() {
  process.send({ orphanPid });
}

async function build() {
  writeFileSync(join(repo, 'partial.mjs'), 'export const partial = true;\n');
  if (mode === 'in-flight') {
    const running = runShell('sleep 600', repo, {
      signal: controller.signal,
      timeout: 10_000,
    });
    ready();
    await running;
  }
  let stoppedReason = 'error';
  if (controller.signal.aborted) {
    stoppedReason = 'cancelled';
  }
  return {
    stoppedReason,
    filesChanged: ['partial.mjs'],
    messages: [],
    usage: { prompt: 10, completion: 5, cost: 0 },
    retries: 0,
  };
}

async function dispatch() {
  const dispose = installCancellationHandlers(controller);
  try {
    const orphan = await runShell('sleep 600 > /dev/null 2>&1 & echo $!', repo);
    orphanPid = Number(orphan.stdout.trim());
    const reporter = {
      ...createNullReporter(),
      notice: (text) => {
        if (text.includes('backing off')) {
          ready();
        }
      },
    };
    const result = await runLoop({
      signal: controller.signal,
      checklist: checklistAdapter(join(repo, 'TASKS.md')),
      git: gitAdapter(repo),
      buildTask: build,
      buildGoal: (goal) =>
        runGoal({
          goal,
          signal: controller.signal,
          runTask: build,
          evaluate: async () => {
            throw new Error('cancelled work must not be judged');
          },
          maxAttempts: 3,
          retryBackoffMs: 60_000,
          reporter,
        }),
      maxAttempts: 3,
      retryBackoffMs: 60_000,
      reporter,
      onRecord: (record) =>
        writeLoopRecord(join(repo, '.kodr/loops/signal.json'), record),
    });
    process.exitCode = 1;
    process.stdout.write(JSON.stringify(result));
  } finally {
    dispose();
  }
}

await main(['loop', '--sweep-grace-ms', '20'], { dispatch });
process.disconnect();
