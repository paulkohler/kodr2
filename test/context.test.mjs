import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildSystemPrompt,
  listWorkspaceFiles,
  readInstructions,
} from '../src/context.mjs';

let tmpDir;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-ctx-'));
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

describe('readInstructions', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('reads KODR.md when present', async () => {
    await writeFile(join(tmpDir, 'KODR.md'), 'project rules here');
    const result = await readInstructions(tmpDir);
    assert.equal(result, 'project rules here');
  });

  it('reads AGENTS.md as fallback', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), 'agent rules');
    const result = await readInstructions(tmpDir);
    assert.equal(result, 'agent rules');
  });

  it('prefers KODR.md over AGENTS.md', async () => {
    await writeFile(join(tmpDir, 'KODR.md'), 'kodr');
    await writeFile(join(tmpDir, 'AGENTS.md'), 'agents');
    const result = await readInstructions(tmpDir);
    assert.equal(result, 'kodr');
  });

  it('returns null when no instruction file exists', async () => {
    const result = await readInstructions(tmpDir);
    assert.equal(result, null);
  });

  it('does not read instruction symlinks escaping workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kodr-instructions-'));
    try {
      await writeFile(join(outside, 'rules.md'), 'outside rules');
      await symlink(join(outside, 'rules.md'), join(tmpDir, 'KODR.md'));
      assert.equal(await readInstructions(tmpDir), null);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('listWorkspaceFiles', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('lists files in workspace', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), '');
    await writeFile(join(tmpDir, 'b.mjs'), '');
    const files = await listWorkspaceFiles(tmpDir);
    assert.ok(files.includes('a.mjs'));
    assert.ok(files.includes('b.mjs'));
  });

  it('skips .git directory', async () => {
    await mkdir(join(tmpDir, '.git'));
    await writeFile(join(tmpDir, '.git/HEAD'), 'ref');
    const files = await listWorkspaceFiles(tmpDir);
    assert.ok(!files.some((f) => f.startsWith('.git')));
  });

  it('skips node_modules', async () => {
    await mkdir(join(tmpDir, 'node_modules'));
    await writeFile(join(tmpDir, 'node_modules/pkg'), '');
    const files = await listWorkspaceFiles(tmpDir);
    assert.ok(!files.some((f) => f.startsWith('node_modules')));
  });

  it('skips build/dependency dirs across ecosystems but keeps source', async () => {
    await mkdir(join(tmpDir, 'target'));
    await writeFile(join(tmpDir, 'target/lib.rlib'), '');
    await mkdir(join(tmpDir, '__pycache__'));
    await writeFile(join(tmpDir, '__pycache__/m.pyc'), '');
    await mkdir(join(tmpDir, 'dist'));
    await writeFile(join(tmpDir, 'dist/bundle.js'), '');
    await writeFile(join(tmpDir, 'src.rs'), '');
    const files = await listWorkspaceFiles(tmpDir);
    assert.ok(files.includes('src.rs'));
    assert.ok(!files.some((f) => f.startsWith('target')));
    assert.ok(!files.some((f) => f.startsWith('__pycache__')));
    assert.ok(!files.some((f) => f.startsWith('dist')));
  });

  it('skips operator logs and copied kodr artifacts', async () => {
    await mkdir(join(tmpDir, 'kodr'));
    await writeFile(join(tmpDir, 'run1.log'), 'log');
    await writeFile(join(tmpDir, 'run-qwen.log'), 'log');
    await writeFile(join(tmpDir, 'kodr/run.json'), '{}');
    await writeFile(join(tmpDir, 'source.mjs'), '');
    const files = await listWorkspaceFiles(tmpDir);
    assert.ok(files.includes('source.mjs'));
    assert.ok(!files.includes('run1.log'));
    assert.ok(!files.includes('run-qwen.log'));
    assert.ok(!files.some((f) => f.startsWith('kodr')));
  });
});

describe('buildSystemPrompt', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('includes base prompt', async () => {
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(prompt.includes('You are Kodr'));
  });

  it('requires native tool-channel calls', async () => {
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(prompt.includes('Use the provided tool channel'));
    assert.ok(prompt.includes('Never write tool calls as plain text'));
    assert.ok(prompt.includes('tool_name[ARGS]'));
  });

  it('discloses the workspace root path and that absolute paths within it are accepted', async () => {
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(
      prompt.includes(`The workspace root is the absolute path: ${tmpDir}`),
    );
    assert.ok(prompt.includes('absolute path as long as it is inside'));
  });

  it('includes workspace instructions when present', async () => {
    await writeFile(join(tmpDir, 'KODR.md'), 'custom rules');
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(prompt.includes('custom rules'));
    assert.ok(prompt.includes('<workspace-instructions>'));
  });

  it('includes file listing', async () => {
    await writeFile(join(tmpDir, 'src.mjs'), '');
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(prompt.includes('src.mjs'));
    assert.ok(prompt.includes('<workspace-files>'));
  });

  it('lists available skills when present', async () => {
    const dir = join(tmpDir, '.kodr', 'skills', 'commit');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: commit\ndescription: Craft a commit\n---\nbody',
    );
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(prompt.includes('<available-skills>'));
    assert.ok(prompt.includes('commit: Craft a commit'));
    assert.ok(prompt.includes('load_skill'));
  });

  it('omits the skills section when no skills exist', async () => {
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(!prompt.includes('<available-skills>'));
  });

  it('includes MEMORY.md as a section distinct from workspace-instructions', async () => {
    await writeFile(join(tmpDir, 'KODR.md'), 'human-authored rules');
    await writeFile(
      join(tmpDir, 'MEMORY.md'),
      'agent-proposed, human-approved lesson',
    );
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(prompt.includes('<memory>'));
    assert.ok(prompt.includes('agent-proposed, human-approved lesson'));
    assert.ok(prompt.includes('<workspace-instructions>'));
    assert.ok(prompt.includes('human-authored rules'));
    // Genuinely separate sections, not one absorbed into the other.
    const memorySection = prompt.slice(
      prompt.indexOf('<memory>'),
      prompt.indexOf('</memory>'),
    );
    assert.ok(!memorySection.includes('human-authored rules'));
  });

  it('omits the memory section when MEMORY.md does not exist', async () => {
    const prompt = await buildSystemPrompt(tmpDir);
    assert.ok(!prompt.includes('<memory>'));
  });
});
