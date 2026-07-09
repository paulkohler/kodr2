import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextVersion, stampVersion } from '../scripts/set-version.mjs';

describe('nextVersion', () => {
  it('keeps major.minor and sets patch to the commit count', () => {
    assert.equal(nextVersion('0.2.0', 94), '0.2.94');
  });

  it('replaces an existing patch number', () => {
    assert.equal(nextVersion('0.2.94', 95), '0.2.95');
  });

  it('accepts a string count', () => {
    assert.equal(nextVersion('1.5.0', '312'), '1.5.312');
  });
});

describe('stampVersion', () => {
  it('rewrites only the version field, preserving formatting', () => {
    const raw =
      '{\n  "name": "kodr2",\n  "version": "0.2.0",\n  "type": "module"\n}\n';
    const out = stampVersion(raw, '0.2.94');
    assert.equal(
      out,
      '{\n  "name": "kodr2",\n  "version": "0.2.94",\n  "type": "module"\n}\n',
    );
  });

  it('leaves other version-like strings untouched', () => {
    const raw =
      '{\n  "version": "0.2.0",\n  "engines": { "node": ">=22" }\n}\n';
    const out = stampVersion(raw, '0.2.94');
    assert.ok(out.includes('"version": "0.2.94"'));
    assert.ok(out.includes('">=22"'));
  });
});
