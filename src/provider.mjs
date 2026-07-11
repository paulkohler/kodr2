/**
 * Provider factory. Selects and constructs the LM Studio, OpenRouter, or
 * Ollama provider -- see specs/provider.yaml. This is the only
 * construction path; callers never import provider-lmstudio.mjs/
 * provider-openrouter.mjs/provider-ollama.mjs directly.
 */

import { createLMStudioProvider } from './provider-lmstudio.mjs';
import { createOllamaProvider } from './provider-ollama.mjs';
import { createOpenRouterProvider } from './provider-openrouter.mjs';

export const DEFAULT_PROVIDER = 'lmstudio';

/**
 * The shared provider contract every factory (lmstudio/openrouter/ollama)
 * returns -- see specs/provider.yaml.
 * @typedef {object} Provider
 * @property {{ modelLifecycle: boolean, contextProbing: boolean, autoDetectModel: boolean, reasoning: boolean }} capabilities
 * @property {Function} chat
 * @property {() => Promise<Array>} models
 * @property {() => Promise<string>} resolveModel
 * @property {(modelId: string) => Promise<{ loaded: number, max: number }>} [contextInfo] - lmstudio/openrouter only
 * @property {() => Promise<Array>} [richModels] - lmstudio only
 * @property {Function} [loadModel] - lmstudio only
 * @property {Function} [ejectModel] - lmstudio only
 */

const FACTORIES = {
  lmstudio: createLMStudioProvider,
  openrouter: createOpenRouterProvider,
  ollama: createOllamaProvider,
};

/**
 * Resolve which provider to use. Precedence: an explicit option, then
 * KODR_PROVIDER, then the default (lmstudio).
 * @param {string} [option]
 * @returns {string}
 */
export function resolveProviderName(option) {
  return option || process.env.KODR_PROVIDER || DEFAULT_PROVIDER;
}

/**
 * Whether reasoning is requested. Precedence: an explicit option (true or
 * false), then KODR_REASONING, then off. Mirrors debugLogEnabled's
 * true/false/env pattern (see specs/debug-log.yaml) -- an explicit false
 * (e.g. the CLI's default when --reasoning wasn't passed) always wins over
 * the env var, so KODR_REASONING only matters for a caller that leaves the
 * option unset entirely.
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function reasoningEnabled(option) {
  if (option === true) {
    return true;
  }
  if (option === false) {
    return false;
  }
  const env = process.env.KODR_REASONING;
  return env === '1' || env === 'true';
}

/**
 * @param {object} [options]
 * @param {string} [options.provider] - "lmstudio", "openrouter", or "ollama" (default lmstudio)
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number} [options.timeout]
 * @param {number} [options.maxRetries]
 * @param {boolean} [options.reasoning] - Only honored by openrouter
 * @param {boolean} [options.noZdr] - Disable OpenRouter Zero Data Retention routing
 * @param {boolean} [options.allowDataCollection] - Allow OpenRouter data-collecting providers
 * @param {string[]} [options.providerOrder] - OpenRouter upstream provider slugs
 * @returns {Provider}
 */
export function createProvider(options = {}) {
  const name = resolveProviderName(options.provider);
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `Unknown provider "${name}" -- must be one of: ${Object.keys(FACTORIES).join(', ')}`,
    );
  }
  const reasoning = reasoningEnabled(options.reasoning);
  const provider = factory({ ...options, reasoning });
  if (reasoning && !provider.capabilities.reasoning) {
    throw new Error(
      `--reasoning requires a provider with reasoning support (resolved provider: "${name}"). Use --provider openrouter.`,
    );
  }
  return provider;
}
