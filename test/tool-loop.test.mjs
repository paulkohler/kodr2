import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	executeRecoveredTextToolCall,
	recoverTextToolCall,
} from '../src/tool-loop.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';

let tmpDir;

async function setup() {
	tmpDir = await mkdtemp(join(tmpdir(), 'kodr-tool-loop-'));
}

async function teardown() {
	await rm(tmpDir, { recursive: true, force: true });
}

describe('recoverTextToolCall', () => {
	it('recovers a single tool_name[ARGS] call with JSON object args', () => {
		const call = recoverTextToolCall(
			'edit_file[ARGS]{"path":"a.mjs","old_string":"x","new_string":"y"}',
		);
		assert.deepEqual(call, {
			name: 'edit_file',
			args: { path: 'a.mjs', old_string: 'x', new_string: 'y' },
		});
	});

	it('rejects non-object args', () => {
		assert.equal(recoverTextToolCall('read_file[ARGS][]'), null);
	});

	it('rejects text that is not exactly a recovered tool call', () => {
		assert.equal(recoverTextToolCall('please run edit_file[ARGS]{}'), null);
	});
});

describe('executeRecoveredTextToolCall', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('routes recovered calls through the tool registry', async () => {
		await writeFile(join(tmpDir, 'target.mjs'), 'export const value = 1;\n');
		const registry = createToolRegistry(tmpDir);
		const messages = [];
		const recovered = await executeRecoveredTextToolCall(
			{
				role: 'assistant',
				content:
					'edit_file[ARGS]{"path":"target.mjs","old_string":"value = 1","new_string":"value = 2"}',
			},
			registry,
			messages,
			true,
		);

		assert.equal(recovered, true);
		assert.equal(
			await readFile(join(tmpDir, 'target.mjs'), 'utf8'),
			'export const value = 2;\n',
		);
		assert.deepEqual(registry.filesChanged(), ['target.mjs']);
		assert.equal(messages[0].role, 'user');
		assert.match(
			messages[0].content,
			/Recovered text-form tool call edit_file/,
		);
	});
});
