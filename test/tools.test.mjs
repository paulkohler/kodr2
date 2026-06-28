import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  readFile,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import readFileTool from '../src/tools/read-file.mjs';
import writeFileTool from '../src/tools/write-file.mjs';
import editFileTool from '../src/tools/edit-file.mjs';
import listFilesTool from '../src/tools/list-files.mjs';
import searchTool from '../src/tools/search.mjs';
import runCommandTool from '../src/tools/run-command.mjs';
import { isPackageManagerCommand } from '../src/tools/run-command.mjs';
import { commandTimeout } from '../src/tools/run-command.mjs';

let tmpDir;
let context;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-test-'));
  const writes = [];
  context = {
    cwd: tmpDir,
    trackWrite(p) {
      writes.push(p);
    },
    _writes: writes,
  };
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

// --- read_file ---

describe('read_file', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('reads a text file', async () => {
    await writeFile(join(tmpDir, 'hello.txt'), 'hello world');
    const result = await readFileTool.execute({ path: 'hello.txt' }, context);
    assert.equal(result.content, 'hello world');
  });

  it('rejects paths escaping workspace', async () => {
    const result = await readFileTool.execute(
      { path: '../../../etc/passwd' },
      context,
    );
    assert.ok(result.error);
    assert.match(result.error, /escape/i);
  });

  it('rejects symlinks escaping workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kodr-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(join(outside, 'secret.txt'), join(tmpDir, 'secret.txt'));
      const result = await readFileTool.execute(
        { path: 'secret.txt' },
        context,
      );
      assert.match(result.error, /escape/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths outside workspace', async () => {
    const result = await readFileTool.execute({ path: '/etc/hosts' }, context);
    assert.match(result.error, /escape/i);
  });

  it('rejects files over 1MB', async () => {
    await writeFile(join(tmpDir, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    const result = await readFileTool.execute({ path: 'large.txt' }, context);
    assert.match(result.error, /too large/i);
  });

  it('returns error for missing files', async () => {
    const result = await readFileTool.execute({ path: 'nope.txt' }, context);
    assert.ok(result.error);
    assert.match(result.error, /not found/i);
  });

  it('rejects binary files', async () => {
    await writeFile(join(tmpDir, 'bin'), Buffer.from([0x00, 0x01, 0x02]));
    const result = await readFileTool.execute({ path: 'bin' }, context);
    assert.ok(result.error);
    assert.match(result.error, /binary/i);
  });

  it('rejects directories', async () => {
    await mkdir(join(tmpDir, 'subdir'));
    const result = await readFileTool.execute({ path: 'subdir' }, context);
    assert.ok(result.error);
    assert.match(result.error, /not a file/i);
  });

  it('requires path parameter', async () => {
    const result = await readFileTool.execute({}, context);
    assert.ok(result.error);
  });
});

// --- write_file ---

describe('write_file', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('writes a new file', async () => {
    const result = await writeFileTool.execute(
      { path: 'out.txt', content: 'data' },
      context,
    );
    assert.equal(result.written, true);
    const content = await readFile(join(tmpDir, 'out.txt'), 'utf8');
    assert.equal(content, 'data');
  });

  it('creates parent directories', async () => {
    const result = await writeFileTool.execute(
      { path: 'a/b/c.txt', content: 'nested' },
      context,
    );
    assert.equal(result.written, true);
    const content = await readFile(join(tmpDir, 'a/b/c.txt'), 'utf8');
    assert.equal(content, 'nested');
  });

  it('rejects paths escaping workspace', async () => {
    const result = await writeFileTool.execute(
      { path: '../../evil.txt', content: 'bad' },
      context,
    );
    assert.ok(result.error);
  });

  it('rejects writes through symlinks escaping workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kodr-outside-'));
    try {
      await symlink(outside, join(tmpDir, 'outside'));
      const result = await writeFileTool.execute(
        { path: 'outside/evil.txt', content: 'bad' },
        context,
      );
      assert.match(result.error, /escape/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('tracks written files', async () => {
    await writeFileTool.execute({ path: 'tracked.txt', content: 'x' }, context);
    assert.ok(context._writes.includes('tracked.txt'));
  });

  it('requires content parameter', async () => {
    const result = await writeFileTool.execute({ path: 'f.txt' }, context);
    assert.ok(result.error);
  });
});

// --- edit_file ---

describe('edit_file', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('edits a file with unique match', async () => {
    await writeFile(join(tmpDir, 'code.mjs'), 'const x = 1;\nconst y = 2;\n');
    const result = await editFileTool.execute(
      {
        path: 'code.mjs',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;',
      },
      context,
    );
    assert.equal(result.edited, true);
    const content = await readFile(join(tmpDir, 'code.mjs'), 'utf8');
    assert.ok(content.includes('const x = 42;'));
  });

  it('rejects when old_string appears multiple times', async () => {
    await writeFile(join(tmpDir, 'dup.mjs'), 'foo\nfoo\n');
    const result = await editFileTool.execute(
      {
        path: 'dup.mjs',
        old_string: 'foo',
        new_string: 'bar',
      },
      context,
    );
    assert.ok(result.error);
    assert.match(result.error, /2 times/);
  });

  it('rejects when old_string not found', async () => {
    await writeFile(join(tmpDir, 'miss.mjs'), 'hello');
    const result = await editFileTool.execute(
      {
        path: 'miss.mjs',
        old_string: 'goodbye',
        new_string: 'hi',
      },
      context,
    );
    assert.ok(result.error);
    assert.match(result.error, /not found/i);
  });

  it('rejects missing files', async () => {
    const result = await editFileTool.execute(
      {
        path: 'gone.mjs',
        old_string: 'a',
        new_string: 'b',
      },
      context,
    );
    assert.ok(result.error);
  });

  it('rejects paths escaping workspace', async () => {
    const result = await editFileTool.execute(
      { path: '../outside.txt', old_string: 'a', new_string: 'b' },
      context,
    );
    assert.match(result.error, /escape/i);
  });

  it('rejects edits through symlinks escaping workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kodr-outside-'));
    try {
      await writeFile(join(outside, 'file.txt'), 'before');
      await symlink(join(outside, 'file.txt'), join(tmpDir, 'file.txt'));
      const result = await editFileTool.execute(
        { path: 'file.txt', old_string: 'before', new_string: 'after' },
        context,
      );
      assert.match(result.error, /escape/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// --- list_files ---

describe('list_files', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('lists files in a directory', async () => {
    await writeFile(join(tmpDir, 'a.txt'), '');
    await writeFile(join(tmpDir, 'b.txt'), '');
    const result = await listFilesTool.execute({}, context);
    assert.ok(result.files.includes('a.txt'));
    assert.ok(result.files.includes('b.txt'));
  });

  it('marks directories with trailing slash', async () => {
    await mkdir(join(tmpDir, 'sub'));
    const result = await listFilesTool.execute({}, context);
    assert.ok(result.files.some((f) => f === 'sub/'));
  });

  it('recursive listing includes nested files', async () => {
    await mkdir(join(tmpDir, 'deep'));
    await writeFile(join(tmpDir, 'deep/inner.txt'), '');
    const result = await listFilesTool.execute({ recursive: true }, context);
    assert.ok(result.files.includes('deep/inner.txt'));
  });

  it('skips .git directory', async () => {
    await mkdir(join(tmpDir, '.git'));
    await writeFile(join(tmpDir, '.git/config'), '');
    const result = await listFilesTool.execute({ recursive: true }, context);
    const gitFiles = result.files.filter((f) => f.startsWith('.git'));
    assert.equal(gitFiles.length, 0);
  });

  it('skips node_modules', async () => {
    await mkdir(join(tmpDir, 'node_modules'));
    await writeFile(join(tmpDir, 'node_modules/pkg.json'), '');
    const result = await listFilesTool.execute({ recursive: true }, context);
    const nmFiles = result.files.filter((f) => f.startsWith('node_modules'));
    assert.equal(nmFiles.length, 0);
  });

  it('skips operator logs and copied kodr artifacts', async () => {
    await mkdir(join(tmpDir, 'kodr'));
    await writeFile(join(tmpDir, 'run1.log'), 'log');
    await writeFile(join(tmpDir, 'run-qwen.log'), 'log');
    await writeFile(join(tmpDir, 'kodr/run.json'), '{}');
    await writeFile(join(tmpDir, 'source.mjs'), '');
    const result = await listFilesTool.execute({ recursive: true }, context);
    assert.ok(result.files.includes('source.mjs'));
    assert.ok(!result.files.includes('run1.log'));
    assert.ok(!result.files.includes('run-qwen.log'));
    assert.ok(!result.files.some((f) => f.startsWith('kodr')));
  });

  it('caps recursive output at 500 entries', async () => {
    await Promise.all(
      Array.from({ length: 510 }, (_, index) =>
        writeFile(join(tmpDir, `file-${index}.txt`), ''),
      ),
    );
    const result = await listFilesTool.execute({ recursive: true }, context);
    assert.equal(result.files.length, 500);
  });

  it('rejects paths escaping workspace', async () => {
    const result = await listFilesTool.execute({ path: '..' }, context);
    assert.match(result.error, /escape/i);
  });
});

// --- search ---

describe('search', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('finds matches in text files', async () => {
    await writeFile(
      join(tmpDir, 'code.mjs'),
      'function hello() {\n  return "hi";\n}\n',
    );
    const result = await searchTool.execute({ pattern: 'hello' }, context);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].file, 'code.mjs');
    assert.equal(result.matches[0].line, 1);
  });

  it('respects glob filter', async () => {
    await writeFile(join(tmpDir, 'a.mjs'), 'target');
    await writeFile(join(tmpDir, 'b.txt'), 'target');
    const result = await searchTool.execute(
      { pattern: 'target', glob: '.mjs' },
      context,
    );
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].file, 'a.mjs');
  });

  it('skips .git directory', async () => {
    await mkdir(join(tmpDir, '.git'));
    await writeFile(join(tmpDir, '.git/config'), 'target');
    const result = await searchTool.execute({ pattern: 'target' }, context);
    assert.equal(result.matches.length, 0);
  });

  it('skips operator logs and copied kodr artifacts', async () => {
    await mkdir(join(tmpDir, 'kodr'));
    await writeFile(join(tmpDir, 'run1.log'), 'target');
    await writeFile(join(tmpDir, 'run-qwen.log'), 'target');
    await writeFile(join(tmpDir, 'kodr/run.json'), 'target');
    await writeFile(join(tmpDir, 'source.mjs'), 'target');
    const result = await searchTool.execute({ pattern: 'target' }, context);
    assert.deepEqual(
      result.matches.map((match) => match.file),
      ['source.mjs'],
    );
  });

  it('does not search symlinks escaping workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kodr-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'target secret');
      await symlink(join(outside, 'secret.txt'), join(tmpDir, 'secret.txt'));
      const result = await searchTool.execute({ pattern: 'target' }, context);
      assert.deepEqual(result.matches, []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('caps output at 100 matches', async () => {
    await writeFile(join(tmpDir, 'many.txt'), 'target\n'.repeat(110));
    const result = await searchTool.execute({ pattern: 'target' }, context);
    assert.equal(result.matches.length, 100);
  });

  it('truncates matching lines to 200 characters', async () => {
    await writeFile(join(tmpDir, 'long.txt'), `target ${'x'.repeat(300)}`);
    const result = await searchTool.execute({ pattern: 'target' }, context);
    assert.equal(result.matches[0].text.length, 200);
  });

  it('rejects paths escaping workspace', async () => {
    const result = await searchTool.execute(
      { pattern: 'target', path: '..' },
      context,
    );
    assert.match(result.error, /escape/i);
  });
});

// --- run_command ---

describe('run_command', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('executes a command and returns output', async () => {
    const result = await runCommandTool.execute(
      { command: 'echo hello' },
      context,
    );
    assert.equal(result.stdout.trim(), 'hello');
    assert.equal(result.exitCode, 0);
  });

  it('captures non-zero exit codes', async () => {
    const result = await runCommandTool.execute(
      { command: 'exit 42' },
      context,
    );
    assert.notEqual(result.exitCode, 0);
  });

  it('tracks files changed by shell commands', async () => {
    const result = await runCommandTool.execute(
      { command: 'printf changed > shell.txt' },
      context,
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.filesChanged, ['shell.txt']);
    assert.deepEqual(context._writes, ['shell.txt']);
  });

  it('requires command parameter', async () => {
    const result = await runCommandTool.execute({}, context);
    assert.ok(result.error);
  });

  it('rejects cd targets outside the workspace', async () => {
    const result = await runCommandTool.execute(
      { command: 'cd /home/user && node --test' },
      context,
    );
    assert.match(result.error, /escapes workspace/i);
  });

  it('allows cd targets inside the workspace', async () => {
    await mkdir(join(tmpDir, 'subdir'));
    const result = await runCommandTool.execute(
      { command: 'cd subdir && pwd' },
      context,
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /subdir/);
  });

  it('does not expose non-allowlisted env vars by default', async () => {
    process.env.KODR_TEST_SECRET = 'shh';
    try {
      const result = await runCommandTool.execute(
        { command: 'echo "[$KODR_TEST_SECRET]"' },
        context,
      );
      assert.equal(result.stdout.trim(), '[]');
    } finally {
      delete process.env.KODR_TEST_SECRET;
    }
  });

  it('exposes env vars named in the passthrough', async () => {
    process.env.KODR_TEST_SECRET = 'shh';
    try {
      const result = await runCommandTool.execute(
        { command: 'echo "[$KODR_TEST_SECRET]"' },
        { ...context, envPassthrough: ['KODR_TEST_SECRET'] },
      );
      assert.equal(result.stdout.trim(), '[shh]');
    } finally {
      delete process.env.KODR_TEST_SECRET;
    }
  });

  it('detects package-manager mutation commands across ecosystems', () => {
    assert.equal(isPackageManagerCommand('npm install express'), true);
    assert.equal(
      isPackageManagerCommand('python -m pip install requests'),
      true,
    );
    assert.equal(isPackageManagerCommand('cargo add serde'), true);
    assert.equal(isPackageManagerCommand('go get example.com/mod'), true);
    assert.equal(isPackageManagerCommand('npm test'), false);
    assert.equal(isPackageManagerCommand('cargo test'), false);
  });

  it('caps command timeout to the remaining run budget', () => {
    const timeout = commandTimeout({
      commandTimeoutMs: 600_000,
      startedAt: new Date(Date.now() - 900),
      maxRunMs: 1000,
    });
    assert.ok(timeout > 0);
    assert.ok(timeout <= 100);
  });
});
