/**
 * Aggregate every saved run record in a runs directory into summary rates,
 * so a slow-burn pattern across many runs (a rising retry rate, a heal
 * success rate trending down) is visible without hand-rolling a one-off
 * jq/grep pass over .kodr/runs/*.json.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Load and parse every run record in a runs directory.
 * @param {string} runsDir
 * @returns {Promise<Array<object>>} Successfully parsed records; a file
 *   that fails to parse is skipped rather than aborting the whole read
 */
export async function loadRunRecords(runsDir) {
  const entries = await readdir(runsDir).catch(() => []);
  const runFiles = entries.filter((name) => name.endsWith('.json'));

  const records = [];
  for (const name of runFiles) {
    try {
      const content = await readFile(join(runsDir, name), 'utf8');
      records.push(JSON.parse(content));
    } catch {
      // Corrupt or truncated run file -- skip it, don't hide the rest.
    }
  }
  return records;
}

/**
 * @typedef {object} Stats
 * @property {number} total
 * @property {Object<string, number>} [stoppedReasonCounts]
 * @property {number} [noOpRate]
 * @property {number} [healAttemptedRate]
 * @property {number|null} [healSuccessRate]
 * @property {number} [compactionRate]
 * @property {number} [avgCompactions]
 * @property {number} [retryRate]
 * @property {number} [avgRetries]
 * @property {number} [verifyAttemptedRate]
 * @property {number|null} [verifyPassRate]
 * @property {number} [avgToolTurns]
 * @property {number|null} [avgDurationMs]
 * @property {{ prompt: number, completion: number, cost: number }} [totalUsage]
 */

/**
 * @typedef {object} RunRecord
 * @property {string} [stoppedReason]
 * @property {boolean} [noOpCompletion]
 * @property {boolean} [healed]
 * @property {number} [compactions]
 * @property {number} [retries]
 * @property {boolean} [verified]
 * @property {number} [toolTurns]
 * @property {number} [durationMs]
 * @property {{ prompt: number, completion: number, cost: number }} [usage]
 */

/**
 * Compute aggregate stats across a set of run records.
 * @param {Array<RunRecord>} records
 * @returns {Stats} See specs/stats.yaml for the full field list
 */
export function computeStats(records) {
  const total = records.length;
  if (total === 0) {
    return { total: 0 };
  }

  const stoppedReasonCounts = {};
  let noOpCount = 0;
  let healAttempted = 0;
  let healSucceeded = 0;
  let compactingRuns = 0;
  let totalCompactions = 0;
  let retryingRuns = 0;
  let totalRetries = 0;
  let verifyAttempted = 0;
  let verifyPassed = 0;
  let totalToolTurns = 0;
  let totalDurationMs = 0;
  let durationSamples = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCost = 0;

  for (const record of records) {
    const reason = record.stoppedReason || 'unknown';
    stoppedReasonCounts[reason] = (stoppedReasonCounts[reason] || 0) + 1;

    if (record.noOpCompletion) {
      noOpCount++;
    }
    if (record.healed !== null && record.healed !== undefined) {
      healAttempted++;
      if (record.healed) {
        healSucceeded++;
      }
    }
    if (record.compactions) {
      compactingRuns++;
      totalCompactions += record.compactions;
    }
    if (record.retries) {
      retryingRuns++;
      totalRetries += record.retries;
    }
    if (record.verified !== null && record.verified !== undefined) {
      verifyAttempted++;
      if (record.verified) {
        verifyPassed++;
      }
    }
    totalToolTurns += record.toolTurns || 0;
    if (Number.isInteger(record.durationMs)) {
      totalDurationMs += record.durationMs;
      durationSamples++;
    }
    if (record.usage) {
      totalPrompt += record.usage.prompt || 0;
      totalCompletion += record.usage.completion || 0;
      totalCost += record.usage.cost || 0;
    }
  }

  return {
    total,
    stoppedReasonCounts,
    noOpRate: noOpCount / total,
    healAttemptedRate: healAttempted / total,
    healSuccessRate: healAttempted > 0 ? healSucceeded / healAttempted : null,
    compactionRate: compactingRuns / total,
    avgCompactions: totalCompactions / total,
    retryRate: retryingRuns / total,
    avgRetries: totalRetries / total,
    verifyAttemptedRate: verifyAttempted / total,
    verifyPassRate: verifyAttempted > 0 ? verifyPassed / verifyAttempted : null,
    avgToolTurns: totalToolTurns / total,
    avgDurationMs:
      durationSamples > 0 ? totalDurationMs / durationSamples : null,
    totalUsage: {
      prompt: totalPrompt,
      completion: totalCompletion,
      cost: totalCost,
    },
  };
}
