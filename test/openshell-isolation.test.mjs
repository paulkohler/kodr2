import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// specs/openshell-isolation.yaml. Everything here drives the wrapper's
// KODR_SHELL_DRYRUN=1 mode, which prints the generated policy and the
// commands it would run and executes none of them -- so these tests need
// neither OpenShell nor Docker installed and stay fast and deterministic.
const SCRIPT = fileURLToPath(
  new URL('../scripts/kodr-shell.sh', import.meta.url),
);
const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * Run the wrapper in dry-run and return its combined output.
 * KODR_SHELL_OPENSHELL points at a path that does not exist: if the wrapper
 * ever actually invoked it, the test would fail rather than silently pass.
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function dryRun(args = [], env = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'kodr-shell-ws-'));
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      KODR_SHELL_DRYRUN: '1',
      KODR_SHELL_SANDBOX: 'test-box',
      KODR_SHELL_WORKSPACE: workspace,
      KODR_SHELL_OPENSHELL: '/nonexistent/openshell',
      ...env,
    },
  });
  return {
    out: `${result.stdout}${result.stderr}`,
    code: result.status,
    workspace,
  };
}

describe('kodr-shell base-url injection', () => {
  it('injects the lmstudio base-url at the host alias by default', () => {
    const { out } = dryRun(['run', 'a task']);
    assert.match(out, /--base-url http:\/\/host\.openshell\.internal:1234\/v1/);
  });

  it('injects the ollama port when --provider ollama', () => {
    const { out } = dryRun(['loop', '--provider', 'ollama']);
    assert.match(
      out,
      /--base-url http:\/\/host\.openshell\.internal:11434\/v1/,
    );
  });

  it('accepts --provider=ollama in equals form too', () => {
    const { out } = dryRun(['loop', '--provider=ollama']);
    assert.match(out, /:11434\/v1/);
  });

  it('does not inject a base-url when the caller passes one', () => {
    const { out } = dryRun(['run', 'x', '--base-url', 'http://mine:9/v1']);
    assert.match(out, /--base-url http:\/\/mine:9\/v1/);
    assert.doesNotMatch(out, /host\.openshell\.internal:1234/);
  });

  it('never injects a base-url for openrouter -- it is reached publicly', () => {
    const { out } = dryRun(['loop', '--provider', 'openrouter']);
    assert.doesNotMatch(out, /--base-url/);
  });
});

describe('kodr-shell generated policy', () => {
  it('carries exactly one network rule in locked mode', () => {
    const { out } = dryRun(['run', 'x']);
    const rules = out.match(/^ {2}[a-z-]+:$/gm) ?? [];
    assert.deepEqual(rules, ['  host-model:']);
  });

  it('scopes the rule to the node binary -- the whole point of OpenShell', () => {
    const { out } = dryRun(['run', 'x']);
    assert.match(out, /binaries:\s*\n\s*- path: \/usr\/local\/bin\/node/);
  });

  it('defaults the node path to /usr/local/bin/node and honours an override', () => {
    const { out } = dryRun(['run', 'x'], { KODR_SHELL_NODE: '/opt/bin/node' });
    assert.match(out, /- path: \/opt\/bin\/node/);
    assert.doesNotMatch(out, /- path: \/usr\/local\/bin\/node/);
  });

  it('moves the allowed endpoint with the host and port overrides', () => {
    // The policy has to follow the base URL or egress is denied in a way that
    // reads exactly like a bad base URL.
    const { out } = dryRun(['run', 'x'], {
      KODR_SHELL_HOST: 'box.local',
      KODR_SHELL_LMSTUDIO_PORT: '9999',
    });
    assert.match(out, /host: box\.local/);
    assert.match(out, /port: 9999/);
    assert.match(out, /--base-url http:\/\/box\.local:9999\/v1/);
  });

  it('adds the provider public host in open mode', () => {
    const { out } = dryRun(['loop', '--provider', 'openrouter'], {
      KODR_SHELL_NETWORK: 'open',
    });
    assert.match(out, /provider-public:/);
    assert.match(out, /host: openrouter\.ai/);
    assert.match(out, /port: 443/);
  });

  it('keeps the workspace writable through include_workdir', () => {
    // 0.1.7's default grants read_write only /tmp and /dev/null.
    const { out } = dryRun(['run', 'x']);
    assert.match(out, /include_workdir: true/);
    assert.doesNotMatch(out, /- \/sandbox\n/);
  });
});

describe('kodr-shell command assembly', () => {
  it('uploads the checkout and the workspace, and never installs anything', () => {
    const { out, workspace } = dryRun(['run', 'x']);
    assert.match(
      out,
      new RegExp(
        `sandbox upload test-box ${REPO.replace(/\/$/, '')} /sandbox --no-git-ignore`,
      ),
    );
    assert.match(
      out,
      new RegExp(
        `sandbox upload test-box ${workspace} /sandbox --no-git-ignore`,
      ),
    );
    assert.doesNotMatch(out, /npm (install|ci)|yarn|pnpm/);
  });

  it('uploads with --no-git-ignore so .git survives for the loop', () => {
    const { out } = dryRun(['loop']);
    const uploads = out.match(/sandbox upload [^\n]*/g) ?? [];
    assert.equal(uploads.length, 2);
    for (const line of uploads) {
      assert.match(line, /--no-git-ignore/);
    }
  });

  it('computes sandbox paths as root/basename, matching upload semantics', () => {
    const { out, workspace } = dryRun(['run', 'x']);
    const wsName = workspace.split('/').pop();
    assert.match(out, new RegExp(`--cwd /sandbox/${wsName}`));
    assert.match(out, /\/sandbox\/kodr2\/bin\/kodr\.mjs/);
  });

  it('injects --cwd unless the caller passes one', () => {
    const { out } = dryRun(['run', 'x', '--cwd', '/elsewhere']);
    assert.match(out, /--cwd \/elsewhere/);
    assert.doesNotMatch(out, /--cwd \/sandbox\//);
  });

  it('forwards the prompt and passthrough args unchanged', () => {
    const { out } = dryRun(['run', 'fix the parser', '--max-tool-turns', '40']);
    assert.match(out, /kodr\.mjs run fix\\ the\\ parser --max-tool-turns 40/);
  });

  it('passes the git identity as environment, not a config write', () => {
    const { out } = dryRun(['loop'], {
      KODR_SHELL_GIT_NAME: 'Tester',
      KODR_SHELL_GIT_EMAIL: 't@example.invalid',
    });
    assert.match(out, /GIT_AUTHOR_NAME=Tester/);
    assert.match(out, /GIT_COMMITTER_EMAIL=t@example\.invalid/);
    assert.doesNotMatch(out, /git config/);
  });

  it('attaches a provider record by name, forwarding no secret value', () => {
    const { out } = dryRun(['loop'], {
      KODR_SHELL_PROVIDER_RECORD: 'my-openrouter',
      OPENROUTER_API_KEY: 'sk-must-not-appear',
    });
    assert.match(out, /--provider my-openrouter/);
    assert.doesNotMatch(out, /sk-must-not-appear/);
  });

  it('emits a docker build only when asked', () => {
    assert.doesNotMatch(dryRun(['run', 'x']).out, /docker build/);
    const { out } = dryRun(['run', 'x'], { KODR_SHELL_BUILD: '1' });
    assert.match(out, /docker build -t kodr-shell:latest/);
  });

  it('holds the sandbox open with a configurable keepalive', () => {
    const { out } = dryRun(['run', 'x'], { KODR_SHELL_KEEPALIVE: '60' });
    assert.match(out, /-- sleep 60/);
  });
});

describe('kodr-shell environment passthrough', () => {
  it('forwards KODR_SHELL_ENV pairs into the exec', () => {
    // An image ENV line does not reach the exec'd process, and kodr's own
    // --env passthrough cannot help because there is nothing in kodr's
    // environment to pass through. This is the only way in.
    const { out } = dryRun(['run', 'x'], {
      KODR_SHELL_ENV: 'CARGO_NET_OFFLINE=true,RUST_BACKTRACE=1',
    });
    assert.match(out, /CARGO_NET_OFFLINE=true/);
    assert.match(out, /RUST_BACKTRACE=1/);
    assert.match(out, /GIT_AUTHOR_NAME=/, 'git identity is still there');
  });

  it('also declares the names to kodr with --env', () => {
    // Setting the variable on kodr's own process is only half of it: kodr
    // replaces its children's environment with a curated allowlist, so hooks
    // and run_command see it UNSET unless the name is admitted with --env.
    // Observed in a sandbox: the prefix alone printed CARGO_NET_OFFLINE=UNSET.
    const { out } = dryRun(['loop'], {
      KODR_SHELL_ENV: 'CARGO_NET_OFFLINE=true,RUST_BACKTRACE=1',
    });
    assert.match(out, /--env CARGO_NET_OFFLINE\\?,RUST_BACKTRACE/);
  });

  it('leaves a caller-supplied --env alone', () => {
    const { out } = dryRun(['loop', '--env', 'MINE'], {
      KODR_SHELL_ENV: 'A=1',
    });
    const envFlags = (out.match(/(^| )--env /g) ?? []).length;
    assert.equal(envFlags, 1, "the caller's --env wins; do not add a second");
    assert.match(out, /--env MINE/);
  });

  it('warns on an entry that is not NAME=VALUE and drops it', () => {
    const { out, code } = dryRun(['run', 'x'], { KODR_SHELL_ENV: 'OOPS' });
    assert.equal(code, 0);
    assert.match(out, /ignoring KODR_SHELL_ENV entry 'OOPS'/);
  });

  it('adds nothing when unset', () => {
    const { out } = dryRun(['run', 'x']);
    assert.doesNotMatch(out, /KODR_SHELL_ENV/);
  });
});

describe('kodr-shell round trip', () => {
  it('emits a download when keeping the sandbox', () => {
    const { out, workspace } = dryRun(['loop'], {
      KODR_SHELL_KEEP: '1',
      KODR_SHELL_DOWNLOAD: '1',
    });
    const wsName = workspace.split('/').pop();
    assert.match(
      out,
      new RegExp(`sandbox download test-box /sandbox/${wsName}`),
    );
    assert.match(out, /\.returned/);
  });

  it('refuses a download that would be deleted with the sandbox', () => {
    const { out, code } = dryRun(['loop'], { KODR_SHELL_DOWNLOAD: '1' });
    assert.equal(code, 2);
    assert.match(out, /needs KODR_SHELL_KEEP=1/);
  });

  it('emits no download by default', () => {
    assert.doesNotMatch(dryRun(['loop']).out, /sandbox download/);
  });
});

describe('kodr-shell policy file', () => {
  it('actually writes the policy to a real temp file', () => {
    // This is the regression guard for a shipped bug: the policy was written
    // with `mktemp .../kodr-shell-policy.XXXXXX.yaml`, and BSD/macOS mktemp
    // requires the Xs at the END of the template, so every real run died with
    // "mkstemp failed ... File exists". 24 dry-run tests missed it because
    // dry-run short-circuited the write. Dry-run now goes through the same
    // path, so this test covers it.
    const { out, code } = dryRun(['run', 'x']);
    assert.equal(code, 0);
    assert.doesNotMatch(out, /mkstemp failed|mktemp:/);
    const match = out.match(/--- generated policy \(([^)]+)\) ---/);
    assert.ok(match, 'dry-run should name the policy file it wrote');
    assert.match(match[1], /\/policy\.yaml$/, 'keeps a .yaml name');
    // the path it names is the one handed to --policy
    assert.ok(
      out.includes(`--policy ${match[1]}`),
      'the generated file is the one passed to sandbox create',
    );
  });
});

describe('kodr-shell dry-run is inert', () => {
  it('prints the policy and the commands while invoking nothing', () => {
    // KODR_SHELL_OPENSHELL is a path that does not exist, so a real
    // invocation would fail the run rather than pass quietly.
    const { out, code } = dryRun(['run', 'x']);
    assert.equal(code, 0);
    assert.match(out, /--- generated policy/);
    assert.match(out, /sandbox create --name test-box/);
    assert.doesNotMatch(out, /No such file|not found/);
  });
});
