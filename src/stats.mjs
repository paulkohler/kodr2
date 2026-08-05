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
 * @property {number} [reviewAttemptedRate]
 * @property {number|null} [reviewPassRate]
 * @property {number|null} [reviewGroundedRate]
 * @property {number|null} [reviewVerdictMissingRate]
 * @property {number} [avgToolTurns]
 * @property {number|null} [avgDurationMs]
 * @property {{ prompt: number, completion: number, cost: number }} [totalUsage]
 */

/**
 * @typedef {object} RunRecord
 * @property {string} [timestamp]
 * @property {string} [stoppedReason]
 * @property {boolean} [noOpCompletion]
 * @property {boolean} [healed]
 * @property {number} [healTurns]
 * @property {number} [compactions]
 * @property {number} [retries]
 * @property {boolean} [verified]
 * @property {{ skipped: boolean, passed?: boolean, grounded?: boolean,
 *   verdictFound?: boolean }|null} [review]
 * @property {number} [toolTurns]
 * @property {number} [durationMs]
 * @property {string[]} [filesChanged]
 * @property {string[]} [packageCommands]
 * @property {{ prompt: number, completion: number, cost: number }} [usage]
 * @property {{ message?: string }} [error]
 */

// null, not 0, when nothing was measured. A zero denominator means "no data",
// and rendering that as 0% reads as "always fails" -- the opposite of the
// truth (see specs/stats.yaml).
function rate(count, denominator) {
  if (denominator > 0) {
    return count / denominator;
  }
  return null;
}

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
  let reviewAttempted = 0;
  let reviewPassed = 0;
  let reviewGrounded = 0;
  let reviewVerdictMissing = 0;
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
    // A skipped review is not an attempted one. That distinction is the whole
    // point of the metric: "half my phases silently never got reviewed" is
    // the failure this is here to make visible, and counting skips as
    // attempts would bury it.
    if (record.review && !record.review.skipped) {
      reviewAttempted++;
      if (record.review.passed) {
        reviewPassed++;
      }
      if (record.review.grounded) {
        reviewGrounded++;
      }
      if (record.review.verdictFound === false) {
        reviewVerdictMissing++;
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
    reviewAttemptedRate: reviewAttempted / total,
    reviewPassRate: rate(reviewPassed, reviewAttempted),
    reviewGroundedRate: rate(reviewGrounded, reviewAttempted),
    reviewVerdictMissingRate: rate(reviewVerdictMissing, reviewAttempted),
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
