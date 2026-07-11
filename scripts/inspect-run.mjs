/**
 * Print the common fields of the most recent run record for a workspace.
 *
 * Debugging a run has repeatedly meant hand-rolling a shell+node one-liner
 * against .kodr/runs/*.json -- and hand-rolled one-liners have repeatedly
 * broken on relative-path require()/readFile calls that resolve against the
 * wrong cwd. This is that one-liner, written once, with absolute paths.
 */

import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// Run filenames are an ISO timestamp with `:`/`.` replaced by `-` (see
// harness.mjs saveRun), e.g. 2026-01-01T00-00-00-000Z.json. Matching this
// shape specifically (not just "any .json file") avoids mistaking a
// workspace root that happens to contain package.json for a runs directory.
const RUN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

/**
 * Resolve the runs directory for a target path: the path itself if it
 * directly contains run files, otherwise `<target>/.kodr/runs`.
 * @param {string} target - Absolute or relative path from the caller's cwd
 * @returns {Promise<string>} Absolute path to the runs directory
 */
export async function resolveRunsDir(target) {
  const absolute = isAbsolute(target) ? target : resolve(target);
  const entries = await readdir(absolute).catch(() => []);
  if (entries.some((name) => RUN_FILE_PATTERN.test(name))) {
    return absolute;
  }
  return join(absolute, '.kodr', 'runs');
}

/**
 * Find the most recent run record in a runs directory. Run filenames sort
 * lexicographically in chronological order, so the last name is the latest
 * run.
 * @param {string} runsDir - Absolute path to a runs directory
 * @returns {Promise<string|null>} Absolute path to the latest run file, or
 *   null when the directory has no run records
 */
export async function findLatestRunFile(runsDir) {
  const entries = await readdir(runsDir).catch(() => []);
  const runFiles = entries.filter((name) => RUN_FILE_PATTERN.test(name)).sort();
  if (runFiles.length === 0) {
    return null;
  }
  return join(runsDir, runFiles[runFiles.length - 1]);
}

/**
 * Format a run record's common fields as human-readable lines.
 * @param {import('../src/stats.mjs').RunRecord} record - A parsed .kodr/runs/*.json record
 * @returns {string}
 */
export function formatRunRecord(record) {
  const lines = [
    `timestamp:        ${record.timestamp}`,
    `stoppedReason:    ${record.stoppedReason}`,
    `verified:         ${record.verified}`,
    `noOpCompletion:   ${record.noOpCompletion}`,
    `healed:           ${record.healed}`,
    `healTurns:        ${record.healTurns}`,
    `toolTurns:        ${record.toolTurns}`,
    `compactions:      ${record.compactions}`,
    `durationMs:       ${record.durationMs}`,
    `filesChanged:     ${(record.filesChanged || []).join(', ') || '(none)'}`,
    `packageCommands:  ${(record.packageCommands || []).join(', ') || '(none)'}`,
  ];
  if (record.usage) {
    lines.push(
      `usage:            ${record.usage.prompt} in / ${record.usage.completion} out`,
    );
  }
  if (record.error) {
    lines.push(`error:            ${record.error.message || record.error}`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || '.';
  const runsDir = await resolveRunsDir(target);
  const latest = await findLatestRunFile(runsDir);
  if (!latest) {
    process.stderr.write(`No run records found in ${runsDir}\n`);
    process.exitCode = 1;
  } else {
    const record = JSON.parse(await readFile(latest, 'utf8'));
    process.stdout.write(`${latest}\n\n${formatRunRecord(record)}\n`);
  }
}
