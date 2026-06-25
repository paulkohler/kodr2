import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { assembleResponse, createClient } from '../src/model.mjs';

const servers = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe('assembleResponse', () => {
	it('assembles content and token usage', () => {
		const result = assembleResponse([
			{ choices: [{ delta: { role: 'assistant', content: 'hello' } }] },
			{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
		]);

		assert.equal(result.message.content, 'hello');
		assert.deepEqual(result.usage, { prompt: 12, completion: 3 });
	});

	it('accumulates tool call arguments and generates missing IDs', () => {
		const result = assembleResponse([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, function: { name: 'read_file', arguments: '{' } },
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '"path":"a"}' } },
							],
						},
					},
				],
			},
		]);

		const call = result.message.tool_calls[0];
		assert.match(call.id, /^call_/);
		assert.equal(call.function.name, 'read_file');
		assert.equal(call.function.arguments, '{"path":"a"}');
	});
});

describe('model HTTP client', () => {
	it('requests streaming usage and returns it', async () => {
		let requestBody;
		const baseUrl = await startServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				requestBody = JSON.parse(body);
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				res.end(
					'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
						'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n' +
						'data: [DONE]\n\n',
				);
			});
		});
		const client = createClient({ baseUrl, model: 'test' });
		const result = await client.chat({ messages: [] });
		assert.deepEqual(requestBody.stream_options, { include_usage: true });
		assert.deepEqual(result.usage, { prompt: 4, completion: 1 });
	});

	it('emits text tokens to onToken as they stream', async () => {
		const baseUrl = await startServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.end(
				'data: {"choices":[{"delta":{"role":"assistant","content":"he"}}]}\n\n' +
					'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
					'data: [DONE]\n\n',
			);
		});
		const client = createClient({ baseUrl, model: 'test' });
		const tokens = [];
		const result = await client.chat({
			messages: [],
			onToken: (t) => tokens.push(t),
		});
		assert.deepEqual(tokens, ['he', 'llo']);
		assert.equal(result.message.content, 'hello');
	});

	it('surfaces HTTP errors from model listing', async () => {
		const baseUrl = await startServer((req, res) => {
			res.writeHead(503);
			res.end('unavailable');
		});
		const client = createClient({ baseUrl });
		await assert.rejects(client.models(), /HTTP 503/);
	});

	it('surfaces HTTP errors from chat', async () => {
		const baseUrl = await startServer((req, res) => {
			res.writeHead(400);
			res.end('bad request');
		});
		const client = createClient({ baseUrl, model: 'test' });
		await assert.rejects(client.chat({ messages: [] }), /HTTP 400/);
	});

	it('times out stalled requests', async () => {
		const baseUrl = await startServer(() => {});
		const client = createClient({ baseUrl, timeout: 20 });
		await assert.rejects(client.models(), /timed out/i);
	});
});

async function startServer(handler) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	return `http://127.0.0.1:${address.port}/v1`;
}

async function closeServer(server) {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}
