import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'bin', 'kodr.mjs');
let tmpDir;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'kodr-distribution-'));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('CLI integration', () => {
	it('prints help and exits successfully', async () => {
		const result = await execute(process.execPath, [CLI, '--help']);
		assert.equal(result.code, 0);
		assert.match(result.stdout, /Usage:/);
	});

	it('prints version and exits successfully', async () => {
		const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
		const result = await execute(process.execPath, [CLI, '--version']);
		assert.equal(result.code, 0);
		assert.match(result.stdout, new RegExp(pkg.version));
	});

	it('returns a failure when the prompt is missing', async () => {
		const result = await execute(process.execPath, [CLI]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /Usage:/);
	});

	it('returns a failure when LM Studio is unavailable', async () => {
		const result = await execute(process.execPath, [
			CLI,
			'run',
			'test prompt',
			'--base-url',
			'http://127.0.0.1:1/v1',
			'--cwd',
			tmpDir,
		]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /Error:/);
	});
});

describe('npm package integration', () => {
	it('contains only public runtime files', async () => {
		const packed = await pack();
		const paths = packed.files.map((file) => file.path);
		assert.ok(paths.includes('bin/kodr.mjs'));
		assert.ok(paths.includes('src/harness.mjs'));
		assert.ok(paths.includes('README.md'));
		assert.ok(paths.includes('LICENSE'));
		assert.ok(!paths.some((path) => path.startsWith('.claude/')));
		assert.ok(!paths.some((path) => path.startsWith('test/')));
		assert.ok(!paths.some((path) => path.startsWith('eval/')));
		assert.ok(!paths.some((path) => path.startsWith('specs/')));
	});

	it('installs and exposes the kodr executable', async () => {
		const packed = await pack();
		const tarball = join(tmpDir, packed.filename);
		const installDir = join(tmpDir, 'install');
		const install = await execute(
			'npm',
			['install', '--ignore-scripts', '--prefix', installDir, tarball],
			{ cwd: tmpDir },
		);
		assert.equal(install.code, 0, install.stderr);

		const executable = join(installDir, 'node_modules', '.bin', 'kodr');
		const result = await execute(executable, ['--help']);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /Usage:/);
	});
});

async function pack() {
	const result = await execute(
		'npm',
		['pack', '--json', '--pack-destination', tmpDir],
		{ cwd: ROOT },
	);
	assert.equal(result.code, 0, result.stderr);
	return JSON.parse(result.stdout)[0];
}

function execute(command, args, options = {}) {
	return new Promise((resolveResult) => {
		const child = spawn(command, args, {
			cwd: options.cwd || ROOT,
			env: process.env,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', (code) => resolveResult({ code, stdout, stderr }));
	});
}
