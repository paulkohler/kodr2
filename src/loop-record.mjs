/**
 * The loop record (specs/loop.yaml) -- `.kodr/loops/<timestamp>.json`,
 * rewritten after every task transition, alongside the per-run records
 * run() already writes to .kodr/runs/. The direct answer to the silent-
 * failure class a shell ratchet can't catch: "five phases never committed"
 * and "logs frozen while healthy" are both one read of this file, and
 * because it is rewritten per transition (not once at the end), a loop that
 * is SIGKILLed or OOM-killed still leaves everything up to its last
 * transition on disk -- the same reasoning specs/incident.yaml applies to a
 * single run, at the loop's altitude.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where loop records live for a workspace. Not overridable today (unlike
 * runsDir) -- no input in specs/loop.yaml asks for it, and a fixed location
 * is what makes `.kodr/loops/` a predictable place to look after a run.
 * @param {string} cwd
 * @returns {string}
 */
export function loopsDir(cwd) {
  return join(cwd, '.kodr', 'loops');
}

/**
 * The record's filename -- the loop's start time, filesystem-safe.
 * @param {Date} startedAt
 * @returns {string}
 */
export function loopRecordFilename(startedAt) {
  return `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`;
}

/**
 * @typedef {object} LoopRecord
 * @property {string} startedAt
 * @property {string|null} reason
 * @property {Array} tasks
 * @property {number} green
 * @property {number} parked
 * @property {{ prompt: number, completion: number, cost: number }} usage
 * @property {number} retries
 * @property {number} durationMs
 */

/**
 * A fresh, empty loop record.
 * @param {Date} startedAt
 * @returns {LoopRecord}
 */
export function createLoopRecord(startedAt) {
  return {
    startedAt: startedAt.toISOString(),
    reason: null,
    tasks: [],
    green: 0,
    parked: 0,
    usage: { prompt: 0, completion: 0, cost: 0 },
    retries: 0,
    durationMs: 0,
  };
}

/**
 * Write the record to disk, creating .kodr/loops/ if needed. Overwrites in
 * place -- the caller calls this again after every task transition, so the
 * file on disk is never more than one transition stale.
 * @param {string} path
 * @param {LoopRecord} record
 * @returns {Promise<void>}
 */
export async function writeLoopRecord(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}
