/**
 * Deterministic support functions for the live compaction eval.
 */

/**
 * Parse a positive integer from an environment-variable value.
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
export function positiveIntEnv(value, fallback) {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return fallback;
  }
  return Number(value);
}

/**
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @typedef {object} CompactionEvalAttempt
 * @property {boolean} passed
 * @property {number} durationMs
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} compactions
 */

/**
 * @param {CompactionEvalAttempt[]} attempts
 * @returns {{ attempts: number, passed: number, passRate: number, medianDurationMs: number|null, medianPromptTokens: number|null, medianCompletionTokens: number|null, medianCompactions: number|null }}
 */
export function summarizeAttempts(attempts) {
  const passed = attempts.filter((attempt) => attempt.passed).length;
  let passRate = 0;
  if (attempts.length > 0) {
    passRate = passed / attempts.length;
  }

  return {
    attempts: attempts.length,
    passed,
    passRate,
    medianDurationMs: median(attempts.map((attempt) => attempt.durationMs)),
    medianPromptTokens: median(attempts.map((attempt) => attempt.promptTokens)),
    medianCompletionTokens: median(
      attempts.map((attempt) => attempt.completionTokens),
    ),
    medianCompactions: median(attempts.map((attempt) => attempt.compactions)),
  };
}

/**
 * Run one live attempt with an abort deadline and a bounded settlement grace.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} runAttempt
 * @param {{ budgetMs: number, graceMs: number }} options
 * @returns {Promise<{ value: T, durationMs: number, timedOut: boolean }>}
 */
export function runWithAbortBudget(runAttempt, options) {
  const { budgetMs, graceMs } = options;
  const controller = new AbortController();
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let graceTimer;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(budgetTimer);
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      callback(value);
    };

    const budgetTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      graceTimer = setTimeout(() => {
        finish(
          reject,
          new Error(
            `Eval attempt did not settle within ${graceMs}ms after abort`,
          ),
        );
      }, graceMs);
    }, budgetMs);

    Promise.resolve()
      .then(() => runAttempt(controller.signal))
      .then(
        (value) => {
          finish(resolve, {
            value,
            durationMs: Date.now() - startedAt,
            timedOut,
          });
        },
        (error) => {
          finish(reject, error);
        },
      );
  });
}
