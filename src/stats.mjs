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
 * @property {Array<ReviewerStats>} [reviewModels]
 * @property {number} [avgToolTurns]
 * @property {number|null} [avgDurationMs]
 * @property {{ prompt: number, completion: number, cost: number }} [totalUsage]
 */

/**
 * @typedef {object} ReviewerStats
 * @property {string} model - The reviewer, or "unknown" for records written
 *   before the reviewer's identity was recorded
 * @property {number} attempted - Reviews this model actually assessed
 * @property {number|null} passRate
 * @property {number|null} groundedRate
 * @property {number|null} verdictMissingRate
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
 * @property {{ skipped: boolean, model?: string, passed?: boolean,
 *   grounded?: boolean, verdictFound?: boolean, reason?: string }|null} [review]
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

// Reviewer choice is load-bearing -- the same diff gets opposite verdicts from
// two models (specs/review.yaml) -- so the review numbers are counted per
// reviewer and the set-wide rates are summed back out of those buckets. One
// accumulation point, so the headline and the breakdown cannot disagree.
// "unknown" covers records written before the reviewer's identity was.
function accumulateReviewer(byModel, review) {
  const model = review.model || 'unknown';
  let entry = byModel.get(model);
  if (!entry) {
    entry = { model, attempted: 0, passed: 0, grounded: 0, verdictMissing: 0 };
    byModel.set(model, entry);
  }
  entry.attempted++;
  if (review.passed) {
    entry.passed++;
  }
  if (review.grounded) {
    entry.grounded++;
  }
  if (review.verdictFound === false) {
    entry.verdictMissing++;
  }
}

function totalReviewCounts(byModel) {
  const totals = { attempted: 0, passed: 0, grounded: 0, verdictMissing: 0 };
  for (const entry of byModel.values()) {
    totals.attempted += entry.attempted;
    totals.passed += entry.passed;
    totals.grounded += entry.grounded;
    totals.verdictMissing += entry.verdictMissing;
  }
  return totals;
}

// Busiest reviewer first, then by name so the report is stable across runs
// (localeCompare would make it depend on the machine's locale).
function compareReviewers(a, b) {
  if (a.attempted !== b.attempted) {
    return b.attempted - a.attempted;
  }
  if (a.model < b.model) {
    return -1;
  }
  if (a.model > b.model) {
    return 1;
  }
  return 0;
}

/**
 * @param {Map<string, { model: string, attempted: number, passed: number,
 *   grounded: number, verdictMissing: number }>} byModel
 * @returns {Array<ReviewerStats>}
 */
function summarizeReviewers(byModel) {
  const entries = [...byModel.values()].map((entry) => ({
    model: entry.model,
    attempted: entry.attempted,
    passRate: rate(entry.passed, entry.attempted),
    groundedRate: rate(entry.grounded, entry.attempted),
    verdictMissingRate: rate(entry.verdictMissing, entry.attempted),
  }));
  entries.sort(compareReviewers);
  return entries;
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
  const reviewsByModel = new Map();
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
      accumulateReviewer(reviewsByModel, record.review);
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

  const review = totalReviewCounts(reviewsByModel);

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
    reviewAttemptedRate: review.attempted / total,
    reviewPassRate: rate(review.passed, review.attempted),
    reviewGroundedRate: rate(review.grounded, review.attempted),
    reviewVerdictMissingRate: rate(review.verdictMissing, review.attempted),
    reviewModels: summarizeReviewers(reviewsByModel),
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
