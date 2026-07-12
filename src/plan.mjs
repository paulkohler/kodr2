/**
 * Planning phase -- an opt-in pre-build phase (see specs/planning.yaml).
 * A single no-tools planner call decomposes the prompt into a fixed,
 * ordered plan of 1..N steps; each step then runs as a fresh sub-agent
 * conversation over the run's shared tool registry. Planning failure
 * always degrades to a single-step plan (behaviorally an unplanned run),
 * never a failed run.
 */

import { PROVIDER_NAMES } from './provider.mjs';
import { loadPrompt } from './prompts.mjs';
import { remainingRunBudgetMs, runToolLoop } from './tool-loop.mjs';
import { extractBalanced, extractFenced } from './tool-recovery.mjs';

export const DEFAULT_PLAN_MAX_STEPS = 8;
export const DEFAULT_PLAN_TIMEOUT_MS = 120_000;
export const DEFAULT_STEP_MIN_MS = 60_000;
export const DEFAULT_STEP_SUMMARY_CAP = 2_000;

const TITLE_CAP = 200;
const DESCRIPTION_CAP = 4_000;

const PLAN_SYSTEM = loadPrompt('plan');
const PLAN_STEP_ADDENDUM = loadPrompt('plan-step');
const PLAN_STEP_FINAL_ADDENDUM = loadPrompt('plan-step-final');

/**
 * Whether the planning phase runs, from --plan or KODR_PLAN.
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function planEnabled(option) {
  if (option) {
    return true;
  }
  const env = process.env.KODR_PLAN;
  return env === '1' || env === 'true';
}

/**
 * Upper bound on plan length. Resolved from an explicit option, then
 * KODR_PLAN_MAX_STEPS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function planMaxSteps(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_PLAN_MAX_STEPS, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_PLAN_MAX_STEPS;
}

/**
 * Cap on the planner call itself; 0 disables the extra cap (the remaining
 * run budget still applies). Resolved from an explicit option, then
 * KODR_PLAN_TIMEOUT_MS, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function planTimeoutMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_PLAN_TIMEOUT_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_PLAN_TIMEOUT_MS;
}

/**
 * Wall-clock floor for each step's share of the remaining run budget.
 * Resolved from an explicit option, then KODR_PLAN_STEP_MIN_MS, then the
 * default.
 * @param {number} [option]
 * @returns {number}
 */
export function stepMinMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_PLAN_STEP_MIN_MS, 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_STEP_MIN_MS;
}

/**
 * Character cap on each step's handoff summary. Resolved from an explicit
 * option, then KODR_PLAN_SUMMARY_CAP, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function stepSummaryCap(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_PLAN_SUMMARY_CAP, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_STEP_SUMMARY_CAP;
}

/**
 * The plan-model spec: which model (and optionally which provider) runs the
 * planner call, so a larger model can plan while a smaller one implements.
 * Resolved from an explicit option, then KODR_PLAN_MODEL, then unset.
 *
 * A spec is either a bare model id ("qwen/qwen3-235b" -- planned on the
 * run's own provider) or provider-prefixed
 * ("openrouter/anthropic/claude-opus-4.8"). The prefix is recognized only
 * when the first path segment is a known provider name, since model ids
 * themselves contain slashes -- "google/gemma-4-26b" is a model on the
 * current provider, not a provider called "google".
 * @param {string} [option]
 * @returns {{ provider: string|null, model: string|null }}
 */
export function planModelSpec(option) {
  const spec = option || process.env.KODR_PLAN_MODEL || null;
  if (!spec) {
    return { provider: null, model: null };
  }
  const slash = spec.indexOf('/');
  if (slash > 0) {
    const head = spec.slice(0, slash);
    if (PROVIDER_NAMES.includes(head)) {
      return { provider: head, model: spec.slice(slash + 1) };
    }
  }
  return { provider: null, model: spec };
}

/**
 * Tool-turn ceiling for each step's loop. Resolved from an explicit option,
 * then KODR_PLAN_STEP_MAX_TOOL_TURNS, then the run's own ceiling -- a plan
 * multiplies turn capacity per step; the wall clock stays the global cap.
 * @param {number|undefined} option
 * @param {number} runMaxToolTurns - The run's own maxToolTurns
 * @returns {number}
 */
export function stepMaxToolTurns(option, runMaxToolTurns) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(
    process.env.KODR_PLAN_STEP_MAX_TOOL_TURNS,
    10,
  );
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return runMaxToolTurns;
}

/**
 * One step of a plan. Statuses transition pending -> running -> done|failed;
 * steps never started because the budget is spent stay pending.
 * @typedef {object} PlanStep
 * @property {number} id - 1-based ordinal
 * @property {string} title
 * @property {string} description
 * @property {'pending'|'running'|'done'|'failed'} status
 * @property {string|null} stoppedReason - The step loop's stop reason once executed
 * @property {string} summary - Handoff text for later steps
 * @property {number} toolTurns
 *
 * @typedef {object} Plan
 * @property {string} createdAt
 * @property {boolean} degraded - True when the single-step fallback is in use
 * @property {string|null} degradedReason - Why planning degraded (chat error, timeout, or validation error text); null when not degraded
 * @property {PlanStep[]} steps
 */

/**
 * Build a Plan from validated { title, description } pairs.
 * @param {Array<{ title: string, description: string }>} steps
 * @param {boolean} degraded
 * @param {string|null} [degradedReason]
 * @returns {Plan}
 */
function buildPlan(steps, degraded, degradedReason = null) {
  return {
    createdAt: new Date().toISOString(),
    degraded,
    degradedReason,
    steps: steps.map((step, index) => ({
      id: index + 1,
      title: step.title,
      description: step.description,
      status: 'pending',
      stoppedReason: null,
      summary: '',
      toolTurns: 0,
    })),
  };
}

/**
 * The degraded plan: one step carrying the whole prompt -- behaviorally
 * today's unplanned run.
 * @param {string} prompt
 * @param {string|null} [reason] - Why planning degraded, for later diagnosis
 * @returns {Plan}
 */
export function fallbackPlan(prompt, reason = null) {
  return buildPlan(
    [{ title: 'Complete the task', description: prompt }],
    true,
    reason,
  );
}

/**
 * Parse and strictly validate a planner reply. Model output is untrusted:
 * fences are stripped, the balanced JSON object is extracted from
 * surrounding prose, types are checked, over-length strings are truncated,
 * and a step count outside 1..maxSteps is rejected outright -- silently
 * truncating a too-long plan would silently drop work.
 * @param {string} text
 * @param {{ maxSteps: number }} options
 * @returns {{ steps?: Array<{ title: string, description: string }>, error?: string }}
 */
export function parsePlanResponse(text, { maxSteps }) {
  const candidate = extractFenced(text || '') ?? (text || '');
  const start = candidate.indexOf('{');
  if (start === -1) {
    return { error: 'no JSON object in planner reply' };
  }
  const json = extractBalanced(candidate, start);
  if (!json) {
    return { error: 'unbalanced JSON in planner reply' };
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: 'planner reply is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) {
    return { error: 'planner reply has no steps array' };
  }
  if (parsed.steps.length === 0) {
    return { error: 'planner reply has zero steps' };
  }
  if (parsed.steps.length > maxSteps) {
    return {
      error: `planner proposed ${parsed.steps.length} steps (max ${maxSteps})`,
    };
  }

  const steps = [];
  for (const step of parsed.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      return { error: 'plan step is not an object' };
    }
    if (typeof step.title !== 'string' || step.title.trim() === '') {
      return { error: 'plan step is missing a title' };
    }
    if (
      typeof step.description !== 'string' ||
      step.description.trim() === ''
    ) {
      return { error: 'plan step is missing a description' };
    }
    steps.push({
      title: step.title.trim().slice(0, TITLE_CAP),
      description: step.description.trim().slice(0, DESCRIPTION_CAP),
    });
  }

  return { steps };
}

/**
 * The planner call's timeout: the configured planner cap (0 disables it)
 * further clamped to the remaining run budget, so planning can never
 * starve the build.
 * @param {number} timeoutMs
 * @param {Date} [startedAt]
 * @param {number} [maxRunMs]
 * @returns {number | undefined}
 */
function plannerTimeoutMs(timeoutMs, startedAt, maxRunMs) {
  const remaining = remainingRunBudgetMs(startedAt, maxRunMs);
  if (!timeoutMs) {
    return remaining;
  }
  if (remaining === undefined) {
    return timeoutMs;
  }
  return Math.min(timeoutMs, remaining);
}

/**
 * Run the planner: a single chat call with no tools whose reply is the
 * plan. Never throws and never fails the run -- any chat error, timeout,
 * or parse/validation failure degrades to the single-step fallback plan,
 * with the reason in `error` and any token usage preserved.
 * @param {object} params
 * @param {import('./provider.mjs').Provider} params.client
 * @param {string} params.modelId
 * @param {string} params.prompt - The user's task prompt, verbatim
 * @param {number} [params.maxSteps]
 * @param {number} [params.timeoutMs] - Planner call cap (0 disables; see planTimeoutMs)
 * @param {Date} [params.startedAt]
 * @param {number} [params.maxRunMs]
 * @param {number} [params.heartbeatMs]
 * @param {function} [params.onHeartbeat]
 * @param {function} [params.onDebug]
 * @returns {Promise<{ plan: Plan, usage: { prompt: number, completion: number, cost: number }, retries: number, error?: string }>}
 */
export async function createPlan(params) {
  const { client, modelId, prompt, startedAt, maxRunMs = 0 } = params;
  const { heartbeatMs, onHeartbeat, onDebug } = params;
  const maxSteps = planMaxSteps(params.maxSteps);
  const timeoutMs = planTimeoutMs(params.timeoutMs);

  const messages = [
    {
      role: 'system',
      content: `${PLAN_SYSTEM}\n\nUse at most ${maxSteps} steps.`,
    },
    { role: 'user', content: prompt },
  ];

  let response;
  try {
    response = await client.chat({
      model: modelId,
      messages,
      timeoutMs: plannerTimeoutMs(timeoutMs, startedAt, maxRunMs),
      heartbeatMs,
      onHeartbeat,
      onDebug,
    });
  } catch (err) {
    return {
      plan: fallbackPlan(prompt, err.message),
      usage: { prompt: 0, completion: 0, cost: 0 },
      retries: err.retries ?? 0,
      error: err.message,
    };
  }

  const usage = response.usage || { prompt: 0, completion: 0, cost: 0 };
  const retries = response.retries || 0;

  const parsed = parsePlanResponse(response.message.content || '', {
    maxSteps,
  });
  if (parsed.error) {
    return {
      plan: fallbackPlan(prompt, parsed.error),
      usage,
      retries,
      error: parsed.error,
    };
  }

  return { plan: buildPlan(parsed.steps, false), usage, retries };
}

/**
 * The synthetic per-step maxRunMs: an equal share of the actual remaining
 * run budget over the remaining steps, with a floor, clamped so no step
 * outlives the real run budget. Recomputed before each step, so a fast
 * early step donates its leftover time to later steps. Passing this (with
 * the run's own startedAt) to an unmodified runToolLoop gives the step a
 * private deadline. Returns 0 (no budget) when the run has none.
 * @param {object} params
 * @param {Date} [params.startedAt]
 * @param {number} params.maxRunMs - The run's real budget (0 disables)
 * @param {number} params.stepsRemaining - Including the step about to run
 * @param {number} params.floorMs
 * @returns {number}
 */
export function stepRunMs({ startedAt, maxRunMs, stepsRemaining, floorMs }) {
  if (!maxRunMs) {
    return 0;
  }
  const elapsed = Date.now() - startedAt.getTime();
  const remaining = maxRunMs - elapsed;
  const share = Math.max(floorMs, remaining / stepsRemaining);
  return Math.min(maxRunMs, elapsed + share);
}

/**
 * One line of the plan as rendered into a step's user message: status,
 * title, and -- for executed steps -- the handoff summary the next agent
 * needs. The assigned step is marked so the sub-agent can locate itself.
 * @param {PlanStep} step
 * @param {number} currentId
 * @returns {string}
 */
function renderPlanLine(step, currentId) {
  if (step.id === currentId) {
    return `${step.id}. [YOUR STEP] ${step.title}`;
  }
  if (step.status === 'done') {
    const handoff = step.summary ? ` — ${step.summary}` : '';
    return `${step.id}. [done] ${step.title}${handoff}`;
  }
  if (step.status === 'failed') {
    const handoff = step.summary ? ` — ${step.summary}` : '';
    return `${step.id}. [failed: ${step.stoppedReason}] ${step.title}${handoff}`;
  }
  return `${step.id}. [pending] ${step.title}`;
}

/**
 * The fresh conversation a step sub-agent starts from: the run's own build
 * system prompt plus the plan-step addendum (and, for the final step only,
 * the closing self-check addendum), and a user message carrying the overall
 * goal, the full plan with statuses and prior handoffs, the files changed
 * so far (a cheap objective handoff supplement), and the assigned step.
 * @param {object} params
 * @param {string} params.systemPrompt - The run's build system prompt
 * @param {string} params.goal - The original user prompt
 * @param {Plan} params.plan
 * @param {PlanStep} params.step - The step to execute
 * @param {string[]} [params.filesChanged] - Files changed by prior steps
 * @param {boolean} [params.isFinalStep] - True for the plan's last step
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildStepMessages({
  systemPrompt,
  goal,
  plan,
  step,
  filesChanged = [],
  isFinalStep = false,
}) {
  const planLines = plan.steps
    .map((s) => renderPlanLine(s, step.id))
    .join('\n');
  const files =
    filesChanged.length > 0
      ? filesChanged.map((file) => `- ${file}`).join('\n')
      : '(none yet)';
  const user = [
    `Overall goal:\n${goal}`,
    `Full plan:\n${planLines}`,
    `Files changed by prior steps:\n${files}`,
    `Your step (${step.id} of ${plan.steps.length}): ${step.title}\n${step.description}`,
  ].join('\n\n');

  let system = `${systemPrompt}\n\n${PLAN_STEP_ADDENDUM}`;
  if (isFinalStep) {
    system = `${system}\n\n${PLAN_STEP_FINAL_ADDENDUM}`;
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * The step's handoff summary: its loop's own final text truncated to the
 * cap -- the plan-step prompt makes the final reply the handoff -- or a
 * deterministic synthesized summary when the step never completed. No
 * extra summarize call.
 * @param {{ finalText: string, stoppedReason: string, toolTurns: number }} loop
 * @param {number} cap
 * @returns {string}
 */
function stepSummaryFrom(loop, cap) {
  const text = (loop.finalText || '').trim();
  if (text) {
    return text.slice(0, cap);
  }
  return `step stopped (${loop.stoppedReason}) after ${loop.toolTurns} tool turns`;
}

/**
 * Execute one plan step as a fresh sub-agent conversation over the run's
 * shared tool registry. The loop's own params (budget, hooks, approval)
 * pass straight through to an unmodified runToolLoop; maxRunMs is the
 * synthetic per-step deadline from stepRunMs. A thrown loop error
 * propagates (the harness catch handles it exactly like the single-loop
 * path).
 * @param {object} params
 * @param {import('./provider.mjs').Provider} params.client
 * @param {string} params.modelId
 * @param {import('./tools/index.mjs').ToolRegistry} params.tools - The run's shared registry
 * @param {string} params.systemPrompt - The run's build system prompt
 * @param {string} params.goal - The original user prompt
 * @param {Plan} params.plan
 * @param {PlanStep} params.step
 * @param {import('./reporter.mjs').Reporter} [params.reporter]
 * @param {Date} [params.startedAt]
 * @param {number} [params.maxRunMs] - Synthetic per-step deadline (see stepRunMs)
 * @param {number} [params.maxToolTurns]
 * @param {number} [params.contextWindow]
 * @param {{ PreToolUse: Array, PostToolUse: Array }} [params.toolHooks]
 * @param {string} [params.cwd]
 * @param {Record<string, string>} [params.commandEnv]
 * @param {number} [params.heartbeatMs]
 * @param {function} [params.onHeartbeat]
 * @param {function} [params.onDebug]
 * @param {boolean} [params.approveCommands]
 * @param {function} [params.confirm]
 * @param {number} [params.summaryCap]
 * @param {boolean} [params.isFinalStep] - True for the plan's last step
 * @returns {Promise<{ status: 'done'|'failed', stoppedReason: string, summary: string, toolTurns: number, compactions: number, usage: { prompt: number, completion: number, cost: number }, retries: number, messages: Array }>}
 */
export async function runStep(params) {
  const {
    systemPrompt,
    goal,
    plan,
    step,
    summaryCap,
    isFinalStep = false,
    ...loopParams
  } = params;

  const messages = buildStepMessages({
    systemPrompt,
    goal,
    plan,
    step,
    filesChanged: params.tools.filesChanged(),
    isFinalStep,
  });

  const loop = await runToolLoop({ ...loopParams, messages });

  /** @type {'done'|'failed'} */
  let status = 'failed';
  if (loop.stoppedReason === 'complete') {
    status = 'done';
  }

  return {
    status,
    stoppedReason: loop.stoppedReason,
    summary: stepSummaryFrom(loop, stepSummaryCap(summaryCap)),
    toolTurns: loop.toolTurns,
    compactions: loop.compactions,
    usage: loop.usage,
    retries: loop.retries,
    messages,
  };
}
