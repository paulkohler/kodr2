import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(repoRoot, 'scripts', 'kodr-box.sh');

/**
 * Run kodr-box.sh in dry-run mode and return the printed docker command.
 * Dry-run never touches Docker, so these tests need neither Docker nor a
 * network. A controlled env avoids leaking the host's real KODR_ or API
 * variables into the assertions.
 * @param {string[]} args - args forwarded to the wrapper
 * @param {Record<string,string>} [extraEnv]
 * @returns {Promise<string>}
 */
async function dryRun(args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    KODR_BOX_DRYRUN: '1',
    ...extraEnv,
  };
  const { stdout } = await execFileAsync('bash', [wrapper, ...args], { env });
  return stdout;
}

describe('kodr-box.sh dry-run', () => {
  it('injects the lmstudio base-url at host.docker.internal:1234 by default', async () => {
    const out = await dryRun(['run', 'hello']);
    assert.match(out, /--base-url http:\/\/host\.docker\.internal:1234\/v1/);
  });

  it('injects the ollama base-url at :11434 when --provider ollama', async () => {
    const out = await dryRun(['run', 'x', '--provider', 'ollama']);
    assert.match(out, /--base-url http:\/\/host\.docker\.internal:11434\/v1/);
  });

  it('does not inject --base-url when the user passes one', async () => {
    const out = await dryRun(['run', 'x', '--base-url', 'http://foo:9/v1']);
    const matches = out.match(/--base-url/g) || [];
    assert.equal(matches.length, 1);
    assert.match(out, /--base-url http:\/\/foo:9\/v1/);
  });

  it('does not inject --base-url for --provider openrouter', async () => {
    const out = await dryRun(['run', 'x', '--provider', 'openrouter'], {
      KODR_BOX_NETWORK: 'open',
    });
    assert.doesNotMatch(out, /--base-url/);
  });

  it('mounts $PWD at /workspace rw and the checkout at /opt/kodr ro', async () => {
    const out = await dryRun(['run', 'x']);
    assert.match(out, new RegExp(`-v ${repoRoot}:/workspace(\\s|$)`));
    assert.match(out, new RegExp(`-v ${repoRoot}:/opt/kodr:ro`));
  });

  it('passes host UID/GID and a writable HOME to the container', async () => {
    const out = await dryRun(['run', 'x']);
    assert.match(out, /-e KODR_UID=\d+ -e KODR_GID=\d+/);
    assert.match(out, /-e HOME=\/tmp/);
  });

  it('locked mode adds NET_ADMIN and KODR_BOX_LOCK=1; open mode does not', async () => {
    const locked = await dryRun(['run', 'x']);
    assert.match(locked, /--cap-add NET_ADMIN/);
    assert.match(locked, /-e KODR_BOX_LOCK=1/);

    const open = await dryRun(['run', 'x'], { KODR_BOX_NETWORK: 'open' });
    assert.doesNotMatch(open, /NET_ADMIN/);
    assert.doesNotMatch(open, /KODR_BOX_LOCK=1/);
  });

  it('forwards a secret env var by name only when set, never its value', async () => {
    const withKey = await dryRun(['run', 'x'], {
      OPENROUTER_API_KEY: 'sk-secret-value',
    });
    assert.match(withKey, /-e OPENROUTER_API_KEY(\s|$)/);
    assert.doesNotMatch(withKey, /sk-secret-value/);

    const without = await dryRun(['run', 'x']);
    assert.doesNotMatch(without, /OPENROUTER_API_KEY/);
  });

  it('injects --cwd for the workspace unless the user passes --cwd', async () => {
    const injected = await dryRun(['run', 'x']);
    assert.match(injected, /--cwd \/workspace/);

    const explicit = await dryRun(['run', 'x', '--cwd', '/other']);
    const matches = explicit.match(/--cwd/g) || [];
    assert.equal(matches.length, 1);
    assert.match(explicit, /--cwd \/other/);
  });

  it('forwards the prompt and passthrough args unchanged', async () => {
    const out = await dryRun([
      'run',
      'add validation',
      '--max-tool-turns',
      '5',
    ]);
    assert.match(out, /run add\\ validation/);
    assert.match(out, /--max-tool-turns 5/);
  });

  it('prints the docker command and starts with `docker run`', async () => {
    const out = await dryRun(['run', 'x']);
    assert.match(out, /^docker run /);
  });
});
