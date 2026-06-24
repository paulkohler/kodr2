import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.mjs';

describe('parseArgs', () => {
	it('extracts prompt from "run" command', () => {
		const args = parseArgs(['run', 'fix the bug']);
		assert.equal(args.prompt, 'fix the bug');
		assert.equal(args.command, 'run');
	});

	it('extracts prompt from shorthand (no command)', () => {
		const args = parseArgs(['fix the bug']);
		assert.equal(args.prompt, 'fix the bug');
	});

	it('parses --cwd flag', () => {
		const args = parseArgs(['run', 'do stuff', '--cwd', '/tmp/project']);
		assert.equal(args.cwd, '/tmp/project');
		assert.equal(args.prompt, 'do stuff');
	});

	it('parses --base-url flag', () => {
		const args = parseArgs(['run', 'hi', '--base-url', 'http://other:5000/v1']);
		assert.equal(args.baseUrl, 'http://other:5000/v1');
	});

	it('parses --model flag', () => {
		const args = parseArgs(['run', 'hi', '--model', 'qwen/qwen3']);
		assert.equal(args.model, 'qwen/qwen3');
	});

	it('parses --test flag', () => {
		const args = parseArgs(['run', 'hi', '--test', 'npm test']);
		assert.equal(args.test, 'npm test');
	});

	it('parses --heal-turns flag', () => {
		const args = parseArgs(['run', 'hi', '--heal-turns', '5']);
		assert.equal(args.healTurns, 5);
	});

	it('parses --quiet flag', () => {
		const args = parseArgs(['run', 'hi', '--quiet']);
		assert.equal(args.quiet, true);
	});

	it('parses -q shorthand', () => {
		const args = parseArgs(['run', 'hi', '-q']);
		assert.equal(args.quiet, true);
	});

	it('parses --continue flag', () => {
		const args = parseArgs(['run', 'hi', '--continue', 'last']);
		assert.equal(args.continue, 'last');
	});

	it('parses --help flag', () => {
		const args = parseArgs(['--help']);
		assert.equal(args.help, true);
	});

	it('parses --version flag', () => {
		const args = parseArgs(['-v']);
		assert.equal(args.version, true);
	});

	it('defaults heal turns to 3', () => {
		const args = parseArgs(['run', 'hi']);
		assert.equal(args.healTurns, 3);
	});

	it('defaults quiet to false', () => {
		const args = parseArgs(['run', 'hi']);
		assert.equal(args.quiet, false);
	});
});
