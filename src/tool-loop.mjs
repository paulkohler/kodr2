/**
 * Shared tool-call execution helpers.
 * Native API tool calls are the primary path. Text-form recovery is a narrow
 * compatibility fallback for models that emit `tool_name[ARGS]{...}` as
 * assistant text after receiving tool results.
 */

import { formatToolCall, formatToolResult } from './format.mjs';

/**
 * Execute native tool calls from a model message.
 * @param {object} message
 * @param {object} tools
 * @param {Array} messages
 * @param {boolean} quiet
 * @returns {Promise<number>} Number of executed calls
 */
export async function executeNativeToolCalls(message, tools, messages, quiet) {
	if (!message.tool_calls || message.tool_calls.length === 0) return 0;

	let executed = 0;
	for (const tc of message.tool_calls) {
		const args = parseToolArguments(tc.function.arguments);
		const result = await dispatchTool(
			toToolCall(tc.function.name, args),
			tools,
			quiet,
		);

		messages.push({
			role: 'tool',
			tool_call_id: tc.id,
			content: JSON.stringify(result),
		});
		executed++;
	}

	return executed;
}

/**
 * Execute a recovered text-form tool call if the message contains exactly one.
 * @param {object} message
 * @param {object} tools
 * @param {Array} messages
 * @param {boolean} quiet
 * @returns {Promise<boolean>}
 */
export async function executeRecoveredTextToolCall(
	message,
	tools,
	messages,
	quiet,
) {
	if (message.tool_calls && message.tool_calls.length > 0) return false;
	const call = recoverTextToolCall(message.content || '');
	if (!call) return false;

	const result = await dispatchTool(call, tools, quiet);
	messages.push({
		role: 'user',
		content: `Recovered text-form tool call ${call.name}. Result:\n${JSON.stringify(result)}`,
	});
	return true;
}

/**
 * Recover a single text-form tool call in the exact shape:
 * `tool_name[ARGS]{...}`.
 * @param {string} content
 * @returns {{ name: string, args: object } | null}
 */
export function recoverTextToolCall(content) {
	const match = content.trim().match(/^([a-z][a-z0-9_]*)\[ARGS\]([\s\S]+)$/);
	if (!match) return null;

	const args = parseToolArguments(match[2]);
	if (!isPlainObject(args)) return null;
	return { name: match[1], args };
}

function parseToolArguments(value) {
	if (!value) return {};
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

function toToolCall(name, args) {
	return { name, args };
}

async function dispatchTool(call, tools, quiet) {
	if (!quiet) process.stderr.write(formatToolCall(call.name, call.args) + '\n');

	const result = await tools.dispatch(call.name, call.args);

	if (!quiet) process.stderr.write(formatToolResult(call.name, result) + '\n');

	return result;
}

function isPlainObject(value) {
	if (!value || typeof value !== 'object') return false;
	return !Array.isArray(value);
}
