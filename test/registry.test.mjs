import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createToolRegistry } from '../src/tools/index.mjs';

let tmpDir;

async function setup() {
	tmpDir = await mkdtemp(join(tmpdir(), 'kodr-reg-'));
}

async function teardown() {
	await rm(tmpDir, { recursive: true, force: true });
}

describe('createToolRegistry', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('returns definitions for all tools', () => {
		const registry = createToolRegistry(tmpDir);
		const defs = registry.definitions();
		assert.ok(defs.length >= 6);
		const names = defs.map((d) => d.name);
		assert.ok(names.includes('read_file'));
		assert.ok(names.includes('write_file'));
		assert.ok(names.includes('edit_file'));
		assert.ok(names.includes('list_files'));
		assert.ok(names.includes('search'));
		assert.ok(names.includes('run_command'));
	});

	it('dispatches known tools', async () => {
		await writeFile(join(tmpDir, 'test.txt'), 'hello');
		const registry = createToolRegistry(tmpDir);
		const result = await registry.dispatch('read_file', { path: 'test.txt' });
		assert.equal(result.content, 'hello');
	});

	it('returns error for unknown tools', async () => {
		const registry = createToolRegistry(tmpDir);
		const result = await registry.dispatch('nonexistent', {});
		assert.ok(result.error);
		assert.match(result.error, /unknown tool/i);
	});

	it('rejects non-object tool arguments', async () => {
		const registry = createToolRegistry(tmpDir);
		for (const args of [null, [], 'invalid']) {
			const result = await registry.dispatch('read_file', args);
			assert.match(result.error, /JSON object/i);
		}
	});

	it('tracks files changed across tool calls', async () => {
		const registry = createToolRegistry(tmpDir);
		await registry.dispatch('write_file', { path: 'a.txt', content: 'a' });
		await registry.dispatch('write_file', { path: 'b.txt', content: 'b' });
		const changed = registry.filesChanged();
		assert.deepEqual(changed, ['a.txt', 'b.txt']);
	});

	it('deduplicates file tracking', async () => {
		const registry = createToolRegistry(tmpDir);
		await registry.dispatch('write_file', { path: 'a.txt', content: 'v1' });
		await registry.dispatch('write_file', { path: 'a.txt', content: 'v2' });
		const changed = registry.filesChanged();
		assert.deepEqual(changed, ['a.txt']);
	});
});
