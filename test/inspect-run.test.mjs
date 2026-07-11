import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  findLatestRunFile,
  formatRunRecord,
  resolveRunsDir,
} from '../scripts/inspect-run.mjs';

let cwd;

afterEach(async () => {
  if (cwd) {
    await rm(cwd, { recursive: true, force: true });
    cwd = undefined;
  }
});

describe('resolveRunsDir', () => {
  it('appends .kodr/runs to a workspace path', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-ws-'));
    assert.equal(await resolveRunsDir(cwd), join(cwd, '.kodr', 'runs'));
  });

  it('uses the path directly when it already looks like a runs directory', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-runsdir-'));
    await writeFile(join(cwd, '2026-01-01T00-00-00-000Z.json'), '{}', 'utf8');
    assert.equal(await resolveRunsDir(cwd), cwd);
  });

  it('does not mistake a workspace root with a package.json for a runs directory', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-pkg-'));
    await writeFile(join(cwd, 'package.json'), '{}', 'utf8');
    assert.equal(await resolveRunsDir(cwd), join(cwd, '.kodr', 'runs'));
  });
});

describe('findLatestRunFile', () => {
  it('returns null for an empty or missing runs directory', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-empty-'));
    assert.equal(await findLatestRunFile(join(cwd, '.kodr', 'runs')), null);
  });

  it('returns the lexicographically last (most recent) run file', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-multi-'));
    const runsDir = join(cwd, '.kodr', 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, '2026-01-01T00-00-00-000Z.json'),
      '{}',
      'utf8',
    );
    await writeFile(
      join(runsDir, '2026-01-02T00-00-00-000Z.json'),
      '{}',
      'utf8',
    );
    await writeFile(join(runsDir, 'not-a-run.txt'), '', 'utf8');

    const latest = await findLatestRunFile(runsDir);
    assert.equal(latest, join(runsDir, '2026-01-02T00-00-00-000Z.json'));
  });
});

describe('formatRunRecord', () => {
  it('renders the common fields, including no-op and error cases', () => {
    const text = formatRunRecord({
      timestamp: '2026-01-01T00:00:02.500Z',
      stoppedReason: 'complete',
      verified: null,
      noOpCompletion: true,
      healed: null,
      healTurns: null,
      toolTurns: 0,
      compactions: 0,
      durationMs: 1200,
      filesChanged: [],
      packageCommands: [],
      usage:
        /** @type {{ prompt: number, completion: number, cost: number }} */ ({
          prompt: 10,
          completion: 5,
        }),
      error: null,
    });

    assert.match(text, /stoppedReason:\s+complete/);
    assert.match(text, /noOpCompletion:\s+true/);
    assert.match(text, /filesChanged:\s+\(none\)/);
    assert.match(text, /usage:\s+10 in \/ 5 out/);
  });
});
