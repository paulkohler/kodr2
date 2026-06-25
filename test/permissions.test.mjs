import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	addAllowedCommand,
	createCommandGate,
	createConfirm,
	loadAllowedCommands,
	parseDecision,
} from '../src/permissions.mjs';

let tmpDir;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'kodr-perm-'));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

async function writeAllowFile(commands) {
	await mkdir(join(tmpDir, '.kodr'), { recursive: true });
	await writeFile(
		join(tmpDir, '.kodr', 'allowed-commands.json'),
		JSON.stringify({ commands }),
		'utf8',
	);
}

async function readAllowFile() {
	const raw = await readFile(
		join(tmpDir, '.kodr', 'allowed-commands.json'),
		'utf8',
	);
	return JSON.parse(raw).commands;
}

describe('loadAllowedCommands', () => {
	it('loads commands from the allowlist file', async () => {
		await writeAllowFile(['npm test', 'git status']);
		assert.deepEqual(await loadAllowedCommands(tmpDir), [
			'npm test',
			'git status',
		]);
	});

	it('returns empty for a missing file', async () => {
		assert.deepEqual(await loadAllowedCommands(tmpDir), []);
	});

	it('returns empty for a malformed file', async () => {
		await mkdir(join(tmpDir, '.kodr'), { recursive: true });
		await writeFile(
			join(tmpDir, '.kodr', 'allowed-commands.json'),
			'not json',
			'utf8',
		);
		assert.deepEqual(await loadAllowedCommands(tmpDir), []);
	});
});

describe('addAllowedCommand', () => {
	it('appends a command', async () => {
		await addAllowedCommand(tmpDir, 'npm test');
		assert.deepEqual(await readAllowFile(), ['npm test']);
	});

	it('de-duplicates on repeat', async () => {
		await addAllowedCommand(tmpDir, 'npm test');
		await addAllowedCommand(tmpDir, 'npm test');
		assert.deepEqual(await readAllowFile(), ['npm test']);
	});
});

describe('createCommandGate', () => {
	function spyConfirm(decision) {
		const calls = [];
		const confirm = async (command) => {
			calls.push(command);
			return decision;
		};
		return { confirm, calls };
	}

	it('allows a command already on the list without prompting', async () => {
		await writeAllowFile(['npm test']);
		const { confirm, calls } = spyConfirm('deny');
		const gate = await createCommandGate({ cwd: tmpDir, confirm });
		assert.deepEqual(await gate.check('npm test'), { allowed: true });
		assert.equal(calls.length, 0);
	});

	it('allows anything when allowAll is set, without persisting', async () => {
		const { confirm, calls } = spyConfirm('deny');
		const gate = await createCommandGate({
			cwd: tmpDir,
			allowAll: true,
			confirm,
		});
		assert.deepEqual(await gate.check('rm -rf /'), { allowed: true });
		assert.equal(calls.length, 0);
		await assert.rejects(readAllowFile());
	});

	it('allows a seeded command without prompting or persisting', async () => {
		const { confirm, calls } = spyConfirm('deny');
		const gate = await createCommandGate({
			cwd: tmpDir,
			seeded: ['npm test'],
			confirm,
		});
		assert.deepEqual(await gate.check('npm test'), { allowed: true });
		assert.equal(calls.length, 0);
		await assert.rejects(readAllowFile());
	});

	it('allow once permits without writing the file', async () => {
		const { confirm } = spyConfirm('once');
		const gate = await createCommandGate({ cwd: tmpDir, confirm });
		assert.deepEqual(await gate.check('ls'), { allowed: true });
		await assert.rejects(readAllowFile());
	});

	it('always allow permits and appends to the file', async () => {
		const { confirm } = spyConfirm('always');
		const gate = await createCommandGate({ cwd: tmpDir, confirm });
		assert.deepEqual(await gate.check('ls'), { allowed: true });
		assert.deepEqual(await readAllowFile(), ['ls']);
	});

	it('deny rejects the command', async () => {
		const { confirm } = spyConfirm('deny');
		const gate = await createCommandGate({ cwd: tmpDir, confirm });
		assert.deepEqual(await gate.check('ls'), { allowed: false });
	});

	it('does not prompt again after allow once in the same run', async () => {
		const { confirm, calls } = spyConfirm('once');
		const gate = await createCommandGate({ cwd: tmpDir, confirm });
		await gate.check('ls');
		await gate.check('ls');
		assert.equal(calls.length, 1);
	});
});

describe('parseDecision', () => {
	it('maps y / yes to once', () => {
		assert.equal(parseDecision('y'), 'once');
		assert.equal(parseDecision('YES'), 'once');
	});

	it('maps a / always to always', () => {
		assert.equal(parseDecision('a'), 'always');
		assert.equal(parseDecision('Always'), 'always');
	});

	it('maps anything else to deny', () => {
		assert.equal(parseDecision('n'), 'deny');
		assert.equal(parseDecision(''), 'deny');
		assert.equal(parseDecision('whatever'), 'deny');
	});
});

describe('createConfirm', () => {
	it('denies without reading input when there is no TTY', async () => {
		let read = false;
		const input = {
			on() {
				read = true;
			},
		};
		const confirm = createConfirm({ isTty: false, input, output: null });
		assert.equal(await confirm('rm -rf /'), 'deny');
		assert.equal(read, false);
	});
});
