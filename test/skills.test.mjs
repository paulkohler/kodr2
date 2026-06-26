import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverSkills, loadSkill, parseFrontmatter } from '../src/skills.mjs';
import loadSkillTool from '../src/tools/load-skill.mjs';

let tmpDir;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-skills-'));
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

async function writeSkill(dirName, content) {
  const dir = join(tmpDir, '.kodr', 'skills', dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content);
}

// --- parseFrontmatter ---

describe('parseFrontmatter', () => {
  it('splits frontmatter and body', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: foo\ndescription: bar\n---\n# Body\ntext',
    );
    assert.equal(frontmatter.name, 'foo');
    assert.equal(frontmatter.description, 'bar');
    assert.equal(body, '# Body\ntext');
  });

  it('strips single and double quotes from values', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: "foo"\ndescription: \'bar baz\'\n---\nbody',
    );
    assert.equal(frontmatter.name, 'foo');
    assert.equal(frontmatter.description, 'bar baz');
  });

  it('returns empty frontmatter when no block is present', () => {
    const { frontmatter, body } = parseFrontmatter('just text');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, 'just text');
  });

  it('preserves body indentation and trailing whitespace', () => {
    const { body } = parseFrontmatter(
      '---\nname: x\n---\n    indented code\nplain line\n',
    );
    assert.equal(body, '    indented code\nplain line\n');
  });
});

// --- discoverSkills ---

describe('discoverSkills', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('discovers skills from SKILL.md frontmatter', async () => {
    await writeSkill(
      'commit',
      '---\nname: commit\ndescription: Write a commit message\n---\nDo the thing.',
    );
    const skills = await discoverSkills(tmpDir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'commit');
    assert.equal(skills[0].description, 'Write a commit message');
  });

  it('falls back to directory name when frontmatter has no name', async () => {
    await writeSkill('review', '---\ndescription: Review code\n---\nbody');
    const skills = await discoverSkills(tmpDir);
    assert.equal(skills[0].name, 'review');
  });

  it('does not expose the skill body', async () => {
    await writeSkill('x', '---\nname: x\ndescription: d\n---\nsecret body');
    const skills = await discoverSkills(tmpDir);
    assert.deepEqual(Object.keys(skills[0]).sort(), ['description', 'name']);
  });

  it('ignores directories without a SKILL.md', async () => {
    await mkdir(join(tmpDir, '.kodr', 'skills', 'empty'), { recursive: true });
    const skills = await discoverSkills(tmpDir);
    assert.deepEqual(skills, []);
  });

  it('returns empty list when no skills directory exists', async () => {
    const skills = await discoverSkills(tmpDir);
    assert.deepEqual(skills, []);
  });
});

// --- loadSkill ---

describe('loadSkill', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns instructions for a known skill', async () => {
    await writeSkill(
      'commit',
      '---\nname: commit\ndescription: d\n---\nStep one.\nStep two.',
    );
    const skill = await loadSkill(tmpDir, 'commit');
    assert.equal(skill.name, 'commit');
    assert.equal(skill.instructions, 'Step one.\nStep two.');
  });

  it('matches the frontmatter name, not the directory name', async () => {
    await writeSkill(
      'dir-name',
      '---\nname: real-name\ndescription: d\n---\nbody',
    );
    assert.equal(await loadSkill(tmpDir, 'dir-name'), null);
    const skill = await loadSkill(tmpDir, 'real-name');
    assert.equal(skill.instructions, 'body');
  });

  it('returns null for an unknown skill', async () => {
    const skill = await loadSkill(tmpDir, 'nope');
    assert.equal(skill, null);
  });
});

// --- load_skill tool ---

describe('load_skill tool', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns the skill instructions', async () => {
    await writeSkill('commit', '---\nname: commit\ndescription: d\n---\nbody');
    const result = await loadSkillTool.execute(
      { name: 'commit' },
      { cwd: tmpDir },
    );
    assert.equal(result.instructions, 'body');
  });

  it('returns an error for an unknown skill', async () => {
    const result = await loadSkillTool.execute(
      { name: 'missing' },
      { cwd: tmpDir },
    );
    assert.ok(result.error);
    assert.match(result.error, /unknown skill/i);
  });

  it('requires a name argument', async () => {
    const result = await loadSkillTool.execute({}, { cwd: tmpDir });
    assert.ok(result.error);
    assert.match(result.error, /name is required/i);
  });
});
