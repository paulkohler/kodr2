import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assembleResponse } from '../src/model.mjs';

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
