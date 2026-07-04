/**
 * Preflight checks for a kodr run's environment.
 * Read-only: never touches a workspace or LM Studio's state.
 */

import { createClient, DEFAULT_BASE_URL } from './model.mjs';
import { runShell } from './shell.mjs';

export const MIN_NODE_MAJOR = 22;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Run all preflight checks.
 * @param {object} [params]
 * @param {string} [params.baseUrl] - LM Studio API base URL
 * @param {string} [params.model] - Model identifier, if explicitly configured
 * @param {number} [params.timeoutMs] - Timeout for the LM Studio reachability probe (default 5000)
 * @param {function} [params.gitCheckFn] - Overridable for tests; defaults to running `git --version`
 * @param {string} [params.nodeVersion] - Overridable for tests; defaults to process.version
 * @returns {Promise<{ checks: Array<{ name: string, status: string, detail: string }>, ok: boolean }>}
 */
export async function runDoctorChecks(params = {}) {
  const baseUrl = params.baseUrl || DEFAULT_BASE_URL;
  const timeoutMs = params.timeoutMs || DEFAULT_TIMEOUT_MS;
  const gitCheckFn = params.gitCheckFn || defaultGitCheck;
  const nodeVersion = params.nodeVersion || process.version;

  const client = createClient({
    baseUrl,
    model: params.model,
    timeout: timeoutMs,
  });

  const checks = [checkNodeVersion(nodeVersion)];

  const lmStudioCheck = await checkLmStudio(client, baseUrl);
  checks.push(lmStudioCheck);

  if (lmStudioCheck.status !== 'fail') {
    checks.push(await checkModel(client));
  }

  checks.push(await checkGit(gitCheckFn));

  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}

/**
 * @param {string} nodeVersion - e.g. "v22.1.0"
 * @returns {{ name: string, status: string, detail: string }}
 */
export function checkNodeVersion(nodeVersion) {
  const major = Number.parseInt(nodeVersion.replace(/^v/, ''), 10);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) {
    return { name: 'Node.js version', status: 'ok', detail: nodeVersion };
  }
  return {
    name: 'Node.js version',
    status: 'fail',
    detail: `${nodeVersion} -- kodr requires Node.js >=${MIN_NODE_MAJOR}`,
  };
}

async function checkLmStudio(client, baseUrl) {
  try {
    await client.models();
    return {
      name: 'LM Studio',
      status: 'ok',
      detail: `reachable at ${baseUrl}`,
    };
  } catch (err) {
    return {
      name: 'LM Studio',
      status: 'fail',
      detail: `not reachable at ${baseUrl} -- ${describeConnectionError(err)}`,
    };
  }
}

function describeConnectionError(err) {
  if (err.code === 'ECONNREFUSED') {
    return 'connection refused -- is LM Studio running?';
  }
  return err.message;
}

async function checkModel(client) {
  const list = await client.models();
  if (list.length === 0) {
    return {
      name: 'model',
      status: 'warn',
      detail: 'no models loaded in LM Studio',
    };
  }
  const modelId = await client.resolveModel();
  return { name: 'model', status: 'ok', detail: modelId };
}

async function checkGit(gitCheckFn) {
  const result = await gitCheckFn();
  if (result.exitCode === 0) {
    return { name: 'git', status: 'ok', detail: result.stdout.trim() };
  }
  return {
    name: 'git',
    status: 'warn',
    detail: 'git not found -- only needed for --raw-then-fix-commits',
  };
}

function defaultGitCheck() {
  return runShell('git --version', process.cwd(), {
    timeout: DEFAULT_TIMEOUT_MS,
  });
}
