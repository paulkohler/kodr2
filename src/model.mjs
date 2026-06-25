/**
 * LM Studio client.
 * Handles chat completions with tool support and streaming.
 * Single provider, single API shape: OpenAI-compatible.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_TIMEOUT = 600_000; // 10 minutes

/**
 * Create a model client bound to an LM Studio instance.
 * @param {object} [options]
 * @param {string} [options.baseUrl] - LM Studio API base URL
 * @param {string} [options.model] - Model identifier
 * @param {number} [options.timeout] - Request timeout in ms
 * @returns {object} Client with `chat` and `models` methods
 */
export function createClient(options = {}) {
	const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
	const model = options.model || '';
	const timeout = options.timeout || DEFAULT_TIMEOUT;

	return { chat, models, resolveModel };

	/**
	 * Send a chat completion request with optional tool definitions.
	 * Streams the response, emitting tokens as they arrive.
	 * Returns the complete message when done.
	 *
	 * @param {object} params
	 * @param {Array} params.messages - Chat messages
	 * @param {Array} [params.tools] - Tool definitions
	 * @param {function} [params.onToken] - Called with each text token
	 * @param {function} [params.onToolCall] - Called when a tool call starts
	 * @returns {Promise<{ message: object, usage: object }>}
	 */
	async function chat(params) {
		const body = {
			model: params.model || model,
			messages: params.messages,
			stream: true,
			stream_options: { include_usage: true },
		};

		if (params.tools && params.tools.length > 0) {
			body.tools = params.tools.map((t) => ({
				type: 'function',
				function: t,
			}));
		}

		return streamRequest(`${baseUrl}/chat/completions`, body, timeout, {
			onToken: params.onToken,
			onToolCall: params.onToolCall,
		});
	}

	/**
	 * List available models.
	 * @returns {Promise<Array<{ id: string }>>}
	 */
	async function models() {
		const data = await jsonRequest(`${baseUrl}/models`, timeout);
		return data.data || [];
	}

	/**
	 * Resolve which model to use. If one was configured, use it.
	 * Otherwise pick the first loaded model from LM Studio.
	 * @returns {Promise<string>}
	 */
	async function resolveModel() {
		if (model) return model;
		const list = await models();
		if (list.length === 0) {
			return 'default';
		}
		return list[0].id;
	}
}

// --- streaming ---

/**
 * Stateful assembler for streamed chat completion chunks.
 * Accumulates content and tool calls, invoking callbacks as deltas arrive.
 */
function createAssembler(onToken, onToolCall) {
	let role = 'assistant';
	let content = '';
	const toolCalls = [];
	let usage = { prompt: 0, completion: 0 };

	function push(chunk) {
		const delta = chunk.choices?.[0]?.delta;
		if (!delta) {
			if (chunk.usage) {
				usage = {
					prompt: chunk.usage.prompt_tokens || 0,
					completion: chunk.usage.completion_tokens || 0,
				};
			}
			return;
		}

		if (delta.role) role = delta.role;

		if (delta.content) {
			content += delta.content;
			if (onToken) onToken(delta.content);
		}

		if (delta.tool_calls) {
			for (const tc of delta.tool_calls) {
				pushToolCall(toolCalls, tc, onToolCall);
			}
		}
	}

	function result() {
		const message = { role, content };
		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls.map((tc) => ({
				id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
				type: 'function',
				function: { name: tc.name, arguments: tc.arguments },
			}));
		}
		return { message, usage };
	}

	return { push, result };
}

function pushToolCall(toolCalls, tc, onToolCall) {
	const idx = tc.index ?? toolCalls.length;
	if (!toolCalls[idx]) {
		toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
		if (tc.function?.name) {
			toolCalls[idx].name = tc.function.name;
			if (onToolCall) onToolCall(toolCalls[idx].name);
		}
	}
	if (tc.function?.name && !toolCalls[idx].name) {
		toolCalls[idx].name = tc.function.name;
		if (onToolCall) onToolCall(toolCalls[idx].name);
	}
	if (tc.function?.arguments) {
		toolCalls[idx].arguments += tc.function.arguments;
	}
	if (tc.id && !toolCalls[idx].id) {
		toolCalls[idx].id = tc.id;
	}
}

/**
 * Assemble a complete response from an array of chunks.
 * Pure helper used by tests; the live path streams via createAssembler.
 */
export function assembleResponse(chunks, onToken, onToolCall) {
	const assembler = createAssembler(onToken, onToolCall);
	for (const chunk of chunks) assembler.push(chunk);
	return assembler.result();
}

// --- HTTP helpers ---

function transportFor(url) {
	return url.protocol === 'https:' ? httpsRequest : httpRequest;
}

function parseSseLine(line) {
	const trimmed = line.trim();
	if (!trimmed || !trimmed.startsWith('data: ')) return null;
	const payload = trimmed.slice(6);
	if (payload === '[DONE]') return null;
	try {
		return JSON.parse(payload);
	} catch {
		return null;
	}
}

function streamRequest(url, body, timeout, callbacks) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const payload = JSON.stringify(body);
		const assembler = createAssembler(callbacks.onToken, callbacks.onToolCall);

		const req = transportFor(parsed)(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload),
				},
				timeout,
			},
			(res) => {
				if (res.statusCode >= 400) {
					let data = '';
					res.on('data', (c) => (data += c));
					res.on('end', () =>
						reject(new Error(`HTTP ${res.statusCode}: ${data}`)),
					);
					return;
				}

				let buffer = '';

				res.setEncoding('utf8');
				res.on('data', (text) => {
					buffer += text;
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const chunk = parseSseLine(line);
						if (chunk) assembler.push(chunk);
					}
				});

				res.on('end', () => {
					const chunk = parseSseLine(buffer);
					if (chunk) assembler.push(chunk);
					resolve(assembler.result());
				});

				res.on('error', reject);
			},
		);

		req.on('timeout', () => {
			req.destroy();
			reject(new Error(`Request timed out after ${timeout}ms`));
		});

		req.on('error', reject);
		req.write(payload);
		req.end();
	});
}

function jsonRequest(url, timeout) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);

		const req = transportFor(parsed)(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: 'GET',
				headers: { Accept: 'application/json' },
				timeout,
			},
			(res) => {
				let data = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (data += c));
				res.on('end', () => {
					if (res.statusCode >= 400) {
						reject(new Error(`HTTP ${res.statusCode}: ${data}`));
						return;
					}
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(new Error(`Invalid JSON: ${e.message}`));
					}
				});
				res.on('error', reject);
			},
		);

		req.on('timeout', () => {
			req.destroy();
			reject(new Error(`Request timed out after ${timeout}ms`));
		});

		req.on('error', reject);
		req.end();
	});
}
