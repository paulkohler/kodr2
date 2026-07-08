/**
 * Preflight checks for a kodr run's environment.
 * Read-only: never touches a workspace or LM Studio's state.
 */

import { DEFAULT_BASE_URL } from './model.mjs';
import { createProvider, resolveProviderName } from './provider.mjs';
import { DEFAULT_OLLAMA_BASE_URL } from './provider-ollama.mjs';
import { DEFAULT_OPENROUTER_BASE_URL } from './provider-openrouter.mjs';
import { runShell } from './shell.mjs';

export const MIN_NODE_MAJOR = 22;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Run all preflight checks.
 * @param {object} [params]
 * @param {string} [params.provider] - "lmstudio", "openrouter", or "ollama" (default lmstudio)
 * @param {string} [params.baseUrl] - Provider API base URL
 * @param {string} [params.model] - Model identifier, if explicitly configured
 * @param {number} [params.timeoutMs] - Timeout for the provider reachability probe (default 5000)
 * @param {function} [params.gitCheckFn] - Overridable for tests; defaults to running `git --version`
 * @param {string} [params.nodeVersion] - Overridable for tests; defaults to process.version
 * @returns {Promise<{ checks: Array<{ name: string, status: string, detail: string }>, ok: boolean }>}
 */
export async function runDoctorChecks(params = {}) {
  const providerName = resolveProviderName(params.provider);
  const displayName = providerDisplayName(providerName);
  const timeoutMs = params.timeoutMs || DEFAULT_TIMEOUT_MS;
  const gitCheckFn = params.gitCheckFn || defaultGitCheck;
  const nodeVersion = params.nodeVersion || process.version;

  const checks = [checkNodeVersion(nodeVersion)];

  let client;
  try {
    client = createProvider({
      provider: params.provider,
      baseUrl: params.baseUrl,
      model: params.model,
      timeout: timeoutMs,
    });
  } catch (err) {
    checks.push({ name: displayName, status: 'fail', detail: err.message });
    checks.push(await checkGit(gitCheckFn));
    return { checks, ok: checks.every((check) => check.status !== 'fail') };
  }

  const providerCheck = await checkProvider(
    client,
    displayName,
    params.baseUrl,
    providerName,
  );
  checks.push(providerCheck);

  if (providerCheck.status !== 'fail') {
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

async function checkProvider(client, displayName, baseUrl, providerName) {
  const url = baseUrl || defaultBaseUrlFor(providerName);
  try {
    await client.models();
    return {
      name: displayName,
      status: 'ok',
      detail: `reachable at ${url}`,
    };
  } catch (err) {
    return {
      name: displayName,
      status: 'fail',
      detail: `not reachable at ${url} -- ${describeConnectionError(err, displayName)}`,
    };
  }
}

function defaultBaseUrlFor(providerName) {
  if (providerName === 'openrouter') {
    return DEFAULT_OPENROUTER_BASE_URL;
  }
  if (providerName === 'ollama') {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  return DEFAULT_BASE_URL;
}

function providerDisplayName(providerName) {
  if (providerName === 'openrouter') {
    return 'OpenRouter';
  }
  if (providerName === 'ollama') {
    return 'Ollama';
  }
  return 'LM Studio';
}

function describeConnectionError(err, displayName) {
  if (err.code === 'ECONNREFUSED') {
    return `connection refused -- is ${displayName} running?`;
  }
  return err.message;
}

async function checkModel(client) {
  const list = await client.models();
  if (list.length === 0) {
    return {
      name: 'model',
      status: 'warn',
      detail: 'no models available from the provider',
    };
  }
  try {
    const modelId = await client.resolveModel();
    return { name: 'model', status: 'ok', detail: modelId };
  } catch (err) {
    return { name: 'model', status: 'warn', detail: err.message };
  }
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
