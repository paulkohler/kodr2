/**
 * Aggregate harness-arena job records into per-variant rows and a markdown
 * report. Pure and dependency-free so it is unit-testable without a model.
 *
 * A "job" is one (task × variant × repeat) run:
 *   { task, variant, passed, toolTurns, promptTokens, completionTokens,
 *     healed, stoppedReason }
 *
 * The report deliberately surfaces cost and recovery, not just pass/fail —
 * at a fixed model the harness drives efficiency far more than raw pass-rate.
 */

/**
 * @param {Array<object>} jobs
 * @returns {Array<object>} one summary row per variant
 */
export function aggregate(jobs) {
  const byVariant = new Map();
  for (const job of jobs) {
    if (!byVariant.has(job.variant)) {
      byVariant.set(job.variant, []);
    }
    byVariant.get(job.variant).push(job);
  }

  const rows = [];
  for (const [variant, runs] of byVariant) {
    rows.push(summarize(variant, runs));
  }
  return rows;
}

function summarize(variant, runs) {
  const tasks = groupBy(runs, (r) => r.task);
  const perTaskPass = [...tasks.values()].map((rs) => indicator(anyPassed(rs)));

  return {
    variant,
    tasks: tasks.size,
    runs: runs.length,
    passAtK: mean(perTaskPass),
    meanTurns: mean(runs.map((r) => r.toolTurns || 0)),
    meanTokens: mean(runs.map((r) => totalTokens(r))),
    heals: runs.filter((r) => r.healed === true).length,
    aborted: runs.filter((r) => r.stoppedReason === 'error').length,
  };
}

function totalTokens(run) {
  return (run.promptTokens || 0) + (run.completionTokens || 0);
}

function anyPassed(runs) {
  return runs.some((r) => r.passed === true);
}

function indicator(value) {
  if (value) {
    return 1;
  }
  return 0;
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(item);
  }
  return map;
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Render aggregate rows as a markdown table.
 * @param {Array<object>} rows
 * @returns {string}
 */
export function toMarkdown(rows) {
  const header =
    '| variant | pass@k | mean turns | mean tokens | heals | aborted | runs |';
  const separator = '|---|---|---|---|---|---|---|';
  const lines = rows.map(
    (r) =>
      `| ${r.variant} | ${percent(r.passAtK)} | ${r.meanTurns.toFixed(1)} | ${Math.round(r.meanTokens)} | ${r.heals} | ${r.aborted} | ${r.runs} |`,
  );
  return [header, separator, ...lines].join('\n');
}

function percent(fraction) {
  return `${Math.round(fraction * 100)}%`;
}
