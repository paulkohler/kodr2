import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv, parseEnvNames } from '../src/env.mjs';

describe('parseEnvNames', () => {
  it('parses a comma-separated list', () => {
    assert.deepEqual(parseEnvNames('A,B,C'), ['A', 'B', 'C']);
  });

  it('trims whitespace and drops empties', () => {
    assert.deepEqual(parseEnvNames(' A , , B '), ['A', 'B']);
  });

  it('de-duplicates names', () => {
    assert.deepEqual(parseEnvNames('A,A,B'), ['A', 'B']);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseEnvNames(''), []);
    assert.deepEqual(parseEnvNames(undefined), []);
  });
});

describe('buildEnv', () => {
  const cleanup = [];

  afterEach(() => {
    for (const name of cleanup.splice(0)) {
      delete process.env[name];
    }
  });

  it('includes default allowlisted variables that are present', () => {
    const env = buildEnv();
    assert.equal(env.PATH, process.env.PATH);
    assert.ok(!('PATH' in env) || typeof env.PATH === 'string');
  });

  it('excludes non-allowlisted variables by default', () => {
    process.env.KODR_TEST_SECRET = 'shh';
    cleanup.push('KODR_TEST_SECRET');
    const env = buildEnv();
    assert.equal(env.KODR_TEST_SECRET, undefined);
  });

  it('includes extra variables named in the passthrough', () => {
    process.env.KODR_TEST_SECRET = 'shh';
    cleanup.push('KODR_TEST_SECRET');
    const env = buildEnv(['KODR_TEST_SECRET']);
    assert.equal(env.KODR_TEST_SECRET, 'shh');
  });

  it('omits passthrough names that are not set', () => {
    const env = buildEnv(['KODR_DEFINITELY_UNSET']);
    assert.ok(!('KODR_DEFINITELY_UNSET' in env));
  });

  it('forwards git identity so commits work without a ~/.gitconfig', () => {
    // kodr loop commits per task. In a container or sandbox there is no
    // ~/.gitconfig, so the environment is the only way to give git an
    // identity; without this the loop does the work and then dies with
    // "Author identity unknown" on its first commit.
    const names = [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ];
    for (const name of names) {
      process.env[name] = `set-${name}`;
      cleanup.push(name);
    }
    const env = buildEnv();
    for (const name of names) {
      assert.equal(env[name], `set-${name}`, `${name} should be forwarded`);
    }
  });
});
