import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

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
    assert.ok(names.includes('load_skill'));
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

  it('seeds filesChanged() from initialFilesChanged', async () => {
    const registry = createToolRegistry(tmpDir, {
      initialFilesChanged: ['prior.mjs'],
    });
    await registry.dispatch('write_file', { path: 'new.mjs', content: 'a' });
    const changed = registry.filesChanged();
    assert.deepEqual(changed, ['prior.mjs', 'new.mjs']);
  });

  it('deduplicates initialFilesChanged against files touched again this session', async () => {
    const registry = createToolRegistry(tmpDir, {
      initialFilesChanged: ['a.mjs', 'a.mjs'],
    });
    await registry.dispatch('write_file', { path: 'a.mjs', content: 'v2' });
    const changed = registry.filesChanged();
    assert.deepEqual(changed, ['a.mjs']);
  });

  it('counts shell commands run', async () => {
    const registry = createToolRegistry(tmpDir);
    assert.equal(registry.commandsRun(), 0);
    await registry.dispatch('run_command', { command: 'true' });
    await registry.dispatch('run_command', { command: 'true' });
    assert.equal(registry.commandsRun(), 2);
  });

  it('tracks package-manager commands without blocking them', async () => {
    const registry = createToolRegistry(tmpDir);
    await registry.dispatch('run_command', {
      command: 'node --version && npm install --help',
    });
    assert.deepEqual(registry.packageCommands(), [
      'node --version && npm install --help',
    ]);
  });

  it('restricts definitions to allowedTools when given', () => {
    const registry = createToolRegistry(tmpDir, {
      allowedTools: ['read_file', 'list_files', 'search'],
    });
    const names = registry.definitions().map((d) => d.name);
    assert.deepEqual(names.sort(), ['list_files', 'read_file', 'search']);
  });

  it('rejects dispatch to a tool excluded by allowedTools', async () => {
    const registry = createToolRegistry(tmpDir, {
      allowedTools: ['read_file'],
    });
    const result = await registry.dispatch('write_file', {
      path: 'a.txt',
      content: 'a',
    });
    assert.match(result.error, /unknown tool/i);
  });
});
