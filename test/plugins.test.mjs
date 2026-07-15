import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { activateReporterPlugins, loadConfig } from '../src/plugins/index.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-plugins-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeConfig(config) {
  await mkdir(join(tmpDir, '.kodr'), { recursive: true });
  await writeFile(
    join(tmpDir, '.kodr', 'plugins.json'),
    JSON.stringify(config),
    'utf8',
  );
}

const creds = { KODR_TELEGRAM_TOKEN: 't', KODR_TELEGRAM_CHAT_ID: '42' };

describe('activateReporterPlugins', () => {
  it('returns a sink reporter for a plugin named in the config', async () => {
    const reporters = await activateReporterPlugins(tmpDir, {
      env: creds,
      config: { plugins: { telegram: { transport: () => {} } } },
    });
    assert.equal(reporters.length, 1);
    assert.equal(typeof reporters[0].turnEnd, 'function');
  });

  it('force-enables a plugin by name', async () => {
    const reporters = await activateReporterPlugins(tmpDir, {
      env: creds,
      enabled: ['telegram'],
      config: { plugins: { telegram: { transport: () => {} } } },
    });
    assert.equal(reporters.length, 1);
  });

  it('returns nothing when no plugin is configured or enabled', async () => {
    const reporters = await activateReporterPlugins(tmpDir, {
      env: creds,
      config: { plugins: {} },
    });
    assert.deepEqual(reporters, []);
  });

  it('skips a plugin whose setup errors and reports a notice', async () => {
    const notices = [];
    const reporters = await activateReporterPlugins(tmpDir, {
      env: {}, // no telegram credentials -> setup returns { error }
      config: { plugins: { telegram: {} } },
      notice: (text) => notices.push(text),
    });
    assert.deepEqual(reporters, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /KODR_TELEGRAM_TOKEN/);
  });

  it('drives the active set from the disk config when none is passed', async () => {
    // No explicit config: the loader must read .kodr/plugins.json. With
    // telegram named but credentials absent, setup returns { error } and the
    // plugin is skipped — so no reporter and no network call.
    await writeConfig({ plugins: { telegram: {} } });
    const notices = [];
    const reporters = await activateReporterPlugins(tmpDir, {
      env: {},
      notice: (text) => notices.push(text),
    });
    assert.deepEqual(reporters, []);
    assert.equal(notices.length, 1);
  });
});

describe('loadConfig', () => {
  it('loads activation config from .kodr/plugins.json', async () => {
    await writeConfig({ plugins: { telegram: {} } });
    const config = await loadConfig(tmpDir);
    assert.deepEqual(config, { plugins: { telegram: {} } });
  });

  it('returns null when no config file exists', async () => {
    assert.equal(await loadConfig(tmpDir), null);
  });

  it('returns null for malformed JSON', async () => {
    await mkdir(join(tmpDir, '.kodr'), { recursive: true });
    await writeFile(
      join(tmpDir, '.kodr', 'plugins.json'),
      '{ not json',
      'utf8',
    );
    assert.equal(await loadConfig(tmpDir), null);
  });
});
