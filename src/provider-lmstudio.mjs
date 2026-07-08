/**
 * LM Studio provider. Wraps model.mjs's OpenAI-compatible client with
 * LM Studio's defaults and its LM-Studio-only capabilities: model
 * auto-detection, context-window probing, and explicit load/eject via the
 * `lms` CLI (see specs/provider.yaml, specs/lms.yaml).
 */

import { ensureModelLoaded, unloadAllModels } from './lms.mjs';
import {
  createClient,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
} from './model.mjs';

export const CAPABILITIES = {
  modelLifecycle: true,
  contextProbing: true,
  autoDetectModel: true,
  reasoning: false,
};

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] - LM Studio API base URL (default localhost:1234)
 * @param {string} [options.model] - Model identifier (auto-detected if omitted)
 * @param {number} [options.timeout] - Request timeout in ms
 * @param {number} [options.maxRetries] - Retries for a 5xx chat response
 * @returns {object} Provider with chat/models/resolveModel/contextInfo/richModels/loadModel/ejectModel
 */
export function createLMStudioProvider(options = {}) {
  const client = createClient({
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    model: options.model,
    timeout: options.timeout,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
  });

  return {
    capabilities: CAPABILITIES,
    chat: client.chat,
    models: client.models,
    resolveModel: client.resolveModel,
    contextInfo: client.contextInfo,
    richModels: client.richModels,
    loadModel: ensureModelLoaded,
    ejectModel: unloadAllModels,
  };
}
