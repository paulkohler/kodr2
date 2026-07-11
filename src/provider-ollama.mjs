/**
 * Ollama provider. Wraps model.mjs's OpenAI-compatible client with Ollama's
 * defaults -- see specs/provider.yaml. Unlike lmstudio/openrouter, one
 * baseUrl covers both shapes Ollama can run in: local (default,
 * http://localhost:11434/v1, no auth) and Ollama's own hosted API
 * (https://ollama.com/v1, needs OLLAMA_API_KEY) -- a caller picks which by
 * setting --base-url, not by choosing a different provider. A local
 * install can also transparently offload a ":cloud"-suffixed model
 * (e.g. "kimi-k2.7-code:cloud") to Ollama's cloud through the *same* local
 * endpoint, so cloud usage doesn't strictly require pointing baseUrl at
 * ollama.com at all -- that's only needed to skip installing Ollama
 * locally entirely.
 *
 * No model-lifecycle management like LM Studio's lms.mjs: Ollama has no
 * equivalent CLI, it auto-loads a model on first request and unloads it
 * after a keep_alive window on its own.
 */

import { createClient, DEFAULT_MAX_RETRIES } from './model.mjs';

/** @typedef {import('./provider.mjs').Provider} Provider */

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export const CAPABILITIES = {
  modelLifecycle: false,
  contextProbing: false,
  autoDetectModel: true,
  reasoning: false,
};

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] - API base URL (default
 *   http://localhost:11434/v1; pass https://ollama.com/v1 for Ollama's
 *   hosted API with no local install)
 * @param {string} [options.model] - Model identifier (auto-detected from
 *   the local/remote model listing if omitted)
 * @param {number} [options.timeout] - Request timeout in ms
 * @param {number} [options.maxRetries] - Retries for a 5xx chat response
 * @param {string} [options.apiKey] - Overridable for tests; defaults to
 *   OLLAMA_API_KEY. Optional, unlike openrouter's -- a local install needs
 *   none, only Ollama's hosted API (or a local install proxying to a
 *   ":cloud" model) does
 * @returns {Provider}
 */
export function createOllamaProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.OLLAMA_API_KEY;

  const client = createClient({
    baseUrl: options.baseUrl || DEFAULT_OLLAMA_BASE_URL,
    model: options.model,
    timeout: options.timeout,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });

  return {
    capabilities: CAPABILITIES,
    chat: client.chat,
    models: client.models,
    resolveModel: client.resolveModel,
    contextInfo,
  };

  /**
   * Ollama's /v1/models reports no context-length field at all (confirmed:
   * id/object/created/owned_by only, unlike LM Studio's /api/v0/models or
   * OpenRouter's context_length). Deliberately does NOT delegate to
   * model.mjs's generic contextInfo/richModels -- that probes LM Studio's
   * /api/v0/models specifically, which Ollama doesn't have, so every call
   * would cost a real (if normally fast-failing) network round-trip to an
   * endpoint that can never succeed, and could stall startup against a
   * slow/nonstandard endpoint in front of Ollama. Returning nulls directly,
   * with no request at all, matches capabilities.contextProbing: false as
   * a hard guarantee, not just a likely outcome.
   */
  async function contextInfo() {
    return { loaded: null, max: null };
  }
}
