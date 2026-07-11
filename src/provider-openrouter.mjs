/**
 * OpenRouter provider. Wraps model.mjs's OpenAI-compatible client with
 * OpenRouter's base URL, bearer auth, reasoning support, and provider
 * routing -- see specs/provider.yaml. OpenRouter has no "currently loaded
 * model" concept and no load/eject lifecycle, unlike LM Studio.
 */

import { parseEnvNames } from './env.mjs';
import { createClient, DEFAULT_MAX_RETRIES } from './model.mjs';

/** @typedef {import('./provider.mjs').Provider} Provider */

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const CAPABILITIES = {
  modelLifecycle: false,
  contextProbing: false,
  autoDetectModel: false,
  reasoning: true,
};

/**
 * Whether to request OpenRouter's Zero Data Retention routing (only
 * providers with a ZDR policy are eligible). On by default -- opinionated,
 * since sending code to a hosted model implies you care about this by
 * default, not only when you remembered to ask for it. Precedence: an
 * explicit noZdr option (true disables), then KODR_OPENROUTER_NO_ZDR, then
 * on.
 * @param {boolean} [noZdr] - Explicit --openrouter-no-zdr flag
 * @returns {boolean}
 */
export function zdrEnabled(noZdr) {
  if (noZdr === true) {
    return false;
  }
  if (noZdr === false) {
    return true;
  }
  const env = process.env.KODR_OPENROUTER_NO_ZDR;
  return !(env === '1' || env === 'true');
}

/**
 * Whether to restrict routing to providers that don't collect/train on
 * prompt data (OpenRouter's `data_collection: "deny"`). On by default, same
 * reasoning as zdrEnabled -- see there. Precedence: an explicit
 * allowDataCollection option (true disables the restriction), then
 * KODR_OPENROUTER_ALLOW_DATA_COLLECTION, then denied (restricted).
 * @param {boolean} [allowDataCollection] - Explicit --openrouter-allow-data-collection flag
 * @returns {boolean}
 */
export function dataCollectionDenied(allowDataCollection) {
  if (allowDataCollection === true) {
    return false;
  }
  if (allowDataCollection === false) {
    return true;
  }
  const env = process.env.KODR_OPENROUTER_ALLOW_DATA_COLLECTION;
  return !(env === '1' || env === 'true');
}

/**
 * Provider slugs to try in order (OpenRouter's `provider.order`).
 * Precedence: an explicit non-empty providerOrder option, then
 * KODR_OPENROUTER_PROVIDER_ONLY (comma-separated), then none.
 * @param {string[]} [option]
 * @returns {string[]}
 */
export function resolveProviderOrder(option) {
  if (Array.isArray(option) && option.length > 0) {
    return option;
  }
  return parseEnvNames(process.env.KODR_OPENROUTER_PROVIDER_ONLY);
}

/**
 * Builds the `provider` routing object OpenRouter's API accepts in the
 * request body (see https://openrouter.ai/docs/features/provider-routing).
 * Returns undefined when there's nothing to say -- ZDR and data-collection
 * denial disabled, and no explicit provider order -- so it's cleanly
 * omittable from the request body rather than sent as an empty object.
 * @param {{ noZdr?: boolean, allowDataCollection?: boolean, providerOrder?: string[] }} options
 * @returns {object|undefined}
 */
function buildProviderRouting(options) {
  const routing = {};
  if (zdrEnabled(options.noZdr)) {
    routing.zdr = true;
  }
  if (dataCollectionDenied(options.allowDataCollection)) {
    routing.data_collection = 'deny';
  }
  const order = resolveProviderOrder(options.providerOrder);
  if (order.length > 0) {
    routing.order = order;
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] - API base URL (default https://openrouter.ai/api/v1)
 * @param {string} [options.model] - Model identifier. Required (directly or
 *   via KODR_MODEL) -- there is no "currently loaded model" to fall back to
 * @param {number} [options.timeout] - Request timeout in ms
 * @param {number} [options.maxRetries] - Retries for a 5xx chat response
 * @param {boolean} [options.reasoning] - Request reasoning tokens
 * @param {boolean} [options.noZdr] - Disable Zero Data Retention routing (on by default)
 * @param {boolean} [options.allowDataCollection] - Disable the data-collection-denied
 *   routing restriction (denied by default)
 * @param {string[]} [options.providerOrder] - Provider slugs to try in order
 *   (OpenRouter's `provider.order`), e.g. ["akashml", "parasail"]
 * @param {string} [options.apiKey] - Overridable for tests; defaults to OPENROUTER_API_KEY
 * @returns {Provider}
 */
export function createOpenRouterProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set -- required to use --provider openrouter',
    );
  }

  const model = options.model || process.env.KODR_MODEL || '';
  const providerRouting = buildProviderRouting(options);

  const client = createClient({
    baseUrl: options.baseUrl || DEFAULT_OPENROUTER_BASE_URL,
    model: options.model,
    timeout: options.timeout,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    headers: { Authorization: `Bearer ${apiKey}` },
    extraBody: {
      ...(options.reasoning ? { reasoning: { enabled: true } } : {}),
      ...(providerRouting ? { provider: providerRouting } : {}),
    },
  });

  return {
    capabilities: CAPABILITIES,
    chat: client.chat,
    models: client.models,
    resolveModel,
    contextInfo,
  };

  async function resolveModel() {
    if (model) {
      return model;
    }
    throw new Error(
      '--model is required with --provider openrouter (no "currently loaded model" to auto-detect)',
    );
  }

  /**
   * OpenRouter's /models listing reports each model's real context_length --
   * unlike LM Studio there's no separate "loaded vs max" distinction (no
   * load state at all), so both fields report the same value. Falls back to
   * nulls on any failure (network error, unknown model id) so callers
   * degrade the same way as a provider with no context data at all.
   */
  async function contextInfo(modelId) {
    try {
      const list = await client.models();
      const match = list.find((m) => m.id === modelId);
      if (!match || !Number.isInteger(match.context_length)) {
        return { loaded: null, max: null };
      }
      return { loaded: match.context_length, max: match.context_length };
    } catch {
      return { loaded: null, max: null };
    }
  }
}
