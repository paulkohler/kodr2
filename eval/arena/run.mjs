/**
 * Harness arena runner.
 *
 * Holds the MODEL fixed and varies the HARNESS: runs each task through Kodr
 * under several feature ablations (Stop gate, heal, reserve), measuring pass@k
 * AND cost (turns, tokens, heals, aborts). This isolates what the harness
 * contributes, the way Harness-Bench / Claw-SWE-Bench do for the field.
 *
 * Not part of `npm test` (it needs a real model and takes minutes). Run with:
 *   npm run arena
 *   npm run arena -- --variant heal --repeats 1        # quick single cell
 *   npm run arena -- --task todo-rust-lib
 *
 * Skips cleanly (exit 0) when the model server is unreachable.
 */

import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregate, toMarkdown } from './report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const KODR = join(ROOT, 'bin', 'kodr.mjs');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = JSON.parse(
    await readFile(join(HERE, 'variants.json'), 'utf8'),
  );
  const tasks = await loadTasks(opts.task);
  const variants = selectVariants(config.variants, opts.variant);
  const baseUrl = config.baseUrl;

  if (!(await modelReachable(baseUrl))) {
    process.stdout.write(
      `arena: model server unreachable at ${baseUrl} — skipping.\n`,
    );
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobsDir = opts.jobsDir || join(HERE, 'jobs', stamp);
  await mkdir(jobsDir, { recursive: true });

  const jobs = [];
  for (const task of tasks) {
    const repeats = opts.repeats || task.repeats || 1;
    for (const variant of variants) {
      for (let k = 0; k < repeats; k++) {
        const job = await runCell({
          task,
          variant,
          k,
          config,
          baseUrl,
          jobsDir,
        });
        jobs.push(job);
        process.stdout.write(
          `  ${task.name} / ${variant.name} #${k + 1}: ${job.passed ? 'pass' : 'fail'} (${job.toolTurns} turns)\n`,
        );
      }
    }
  }

  const rows = aggregate(jobs);
  const report = toMarkdown(rows);
  await writeFile(join(jobsDir, 'jobs.json'), JSON.stringify(jobs, null, 2));
  await writeFile(join(jobsDir, 'report.md'), `${report}\n`);
  process.stdout.write(`\n${report}\n\njobs: ${jobsDir}\n`);
}

/** Run one (task × variant × repeat) cell and return its job record. */
async function runCell({ task, variant, k, config, baseUrl, jobsDir }) {
  const ws = await mkdtemp(join(tmpdir(), `arena-${task.name}-`));
  const recordDir = join(jobsDir, 'records', `${variant.name}-${k}`);

  try {
    if (task.setup) {
      await sh(task.setup, ws);
    }
    await runKodr({ task, variant, config, baseUrl, ws, recordDir });

    // The task's own verify is the ground truth, independent of any Stop gate.
    const passed = (await sh(task.verify, ws)).code === 0;
    const record = await readLatestRecord(recordDir);
    return jobFrom(task, variant, k, passed, record);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

function runKodr({ task, variant, config, baseUrl, ws, recordDir }) {
  const args = [
    KODR,
    'run',
    task.prompt,
    '--cwd',
    ws,
    '--model',
    config.model,
    '--base-url',
    baseUrl,
    '--max-run-ms',
    String(task.budgetMs || 0),
    '--heal-turns',
    String(variant.healTurns ?? 0),
    '--runs-dir',
    recordDir,
    '--quiet',
  ];
  if (variant.useGate) {
    args.push('--test', task.verify);
  }
  const env = { ...process.env, ...(variant.env || {}) };
  return spawnDone('node', args, { cwd: ws, env });
}

function jobFrom(task, variant, k, passed, record) {
  return {
    task: task.name,
    variant: variant.name,
    repeat: k,
    passed,
    toolTurns: record?.toolTurns ?? 0,
    promptTokens: record?.usage?.prompt ?? 0,
    completionTokens: record?.usage?.completion ?? 0,
    healed: record?.healed ?? null,
    stoppedReason: record?.stoppedReason ?? 'unknown',
  };
}

async function readLatestRecord(dir) {
  try {
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort();
    if (files.length === 0) {
      return null;
    }
    return JSON.parse(
      await readFile(join(dir, files[files.length - 1]), 'utf8'),
    );
  } catch {
    return null;
  }
}

async function loadTasks(filter) {
  const dir = join(HERE, 'tasks');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.task.json'));
  const tasks = [];
  for (const file of files) {
    const task = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (!filter || task.name === filter) {
      tasks.push(task);
    }
  }
  return tasks;
}

function selectVariants(variants, filter) {
  if (!filter) {
    return variants;
  }
  return variants.filter((v) => v.name === filter);
}

async function modelReachable(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sh(command, cwd) {
  return spawnDone('/bin/sh', ['-c', command], { cwd });
}

/** Spawn a process and resolve with its exit code; never rejects. */
function spawnDone(cmd, args, options) {
  return new Promise((resolveProcess) => {
    const child = spawn(cmd, args, { stdio: 'ignore', ...options });
    child.on('close', (code) => resolveProcess({ code: code ?? 1 }));
    child.on('error', () => resolveProcess({ code: 1 }));
  });
}

function parseArgs(argv) {
  const opts = { task: null, variant: null, repeats: 0, jobsDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') {
      opts.task = argv[++i];
    } else if (argv[i] === '--variant') {
      opts.variant = argv[++i];
    } else if (argv[i] === '--repeats') {
      opts.repeats = Number.parseInt(argv[++i], 10) || 0;
    } else if (argv[i] === '--jobs-dir') {
      opts.jobsDir = argv[++i];
    }
  }
  return opts;
}

main().catch((err) => {
  process.stderr.write(`arena failed: ${err.message}\n`);
  process.exitCode = 1;
});
