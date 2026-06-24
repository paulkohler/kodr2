/**
 * Integration eval — end-to-end harness against LM Studio.
 *
 * Run with: node --test eval/harness.eval.mjs
 * Requires LM Studio running at localhost:1234 with a model loaded.
 *
 * These tests are expected to be slow (seconds per case) and
 * non-deterministic (model output varies). Track pass rates, not
 * binary pass/fail.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';

import { run } from '../src/harness.mjs';

const LM_STUDIO_URL = 'http://localhost:1234/v1';

async function lmStudioAvailable() {
	return new Promise((resolve) => {
		const req = request(`${LM_STUDIO_URL}/models`, { timeout: 3000 }, (res) => {
			let data = '';
			res.on('data', (c) => (data += c));
			res.on('end', () => resolve(true));
		});
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

describe('harness eval', {
	skip: !(await lmStudioAvailable()) && 'LM Studio not available',
}, () => {
	let tmpDir;

	before(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'kodr-eval-'));
	});

	after(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	it('creates a file when asked', { timeout: 120_000 }, async () => {
		const result = await run(
			'Create a file called hello.mjs that exports a function named greet which takes a name parameter and returns "Hello, <name>!"',
			{ cwd: tmpDir, baseUrl: LM_STUDIO_URL, quiet: true },
		);

		assert.ok(
			result.filesChanged.length > 0,
			'should change at least one file',
		);

		// Check the file exists and has reasonable content
		const content = await readFile(join(tmpDir, 'hello.mjs'), 'utf8');
		assert.ok(content.includes('greet'), 'file should contain greet function');
		assert.ok(content.includes('export'), 'file should have an export');
	});

	it('reads and modifies an existing file', { timeout: 120_000 }, async () => {
		// Create a file with a deliberate bug
		await writeFile(
			join(tmpDir, 'buggy.mjs'),
			'export function add(a, b) {\n  return a - b; // BUG: should be +\n}\n',
		);

		const result = await run(
			'Read buggy.mjs and fix the bug in the add function. It should add, not subtract.',
			{ cwd: tmpDir, baseUrl: LM_STUDIO_URL, quiet: true },
		);

		const content = await readFile(join(tmpDir, 'buggy.mjs'), 'utf8');
		assert.ok(
			content.includes('+') || content.includes('a + b'),
			'should fix the subtraction to addition',
		);
	});

	it('uses tools to explore before writing', { timeout: 120_000 }, async () => {
		// Create a small project structure
		await mkdir(join(tmpDir, 'explore-test'), { recursive: true });
		await writeFile(join(tmpDir, 'explore-test/config.json'), '{"port": 3000}');
		await writeFile(
			join(tmpDir, 'explore-test/app.mjs'),
			'import config from "./config.json" assert { type: "json" };\n',
		);

		const result = await run(
			'Look at the explore-test directory. What port is configured in config.json?',
			{ cwd: tmpDir, baseUrl: LM_STUDIO_URL, quiet: true },
		);

		assert.ok(result.toolTurns > 0, 'should have used tools');
		assert.ok(result.response.includes('3000'), 'should mention port 3000');
	});

	it('tool loop terminates within limit', { timeout: 180_000 }, async () => {
		const result = await run('List the files in this directory.', {
			cwd: tmpDir,
			baseUrl: LM_STUDIO_URL,
			quiet: true,
		});

		assert.ok(result.toolTurns <= 20, 'should not exceed 20 tool turns');
	});
});
