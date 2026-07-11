import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { checkNodeVersion, runDoctorChecks } from '../src/doctor.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

async function startServer(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  return `http://127.0.0.1:${address.port}/v1`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function okGitCheck() {
  return Promise.resolve({ exitCode: 0, stdout: 'git version 2.42.0\n' });
}

function missingGitCheck() {
  return Promise.resolve({ exitCode: 127, stdout: '', stderr: 'not found' });
}

describe('checkNodeVersion', () => {
  it('is ok at or above the minimum', () => {
    assert.equal(checkNodeVersion('v22.1.0').status, 'ok');
    assert.equal(checkNodeVersion('v24.0.0').status, 'ok');
  });

  it('fails below the minimum', () => {
    const check = checkNodeVersion('v18.19.0');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, />=22/);
  });
});

describe('runDoctorChecks', () => {
  it('reports LM Studio reachable when the server responds', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
    });

    const report = await runDoctorChecks({ baseUrl, gitCheckFn: okGitCheck });
    const lmStudio = report.checks.find((c) => c.name === 'LM Studio');
    assert.equal(lmStudio.status, 'ok');
  });

  it('reports a fail with an "is LM Studio running?" hint on ECONNREFUSED', async () => {
    const report = await runDoctorChecks({
      baseUrl: 'http://127.0.0.1:1/v1',
      gitCheckFn: okGitCheck,
    });
    const lmStudio = report.checks.find((c) => c.name === 'LM Studio');
    assert.equal(lmStudio.status, 'fail');
    assert.match(lmStudio.detail, /is LM Studio running\?/);
    assert.equal(report.ok, false);
  });

  it('reports a fail on a timeout', async () => {
    const baseUrl = await startServer(() => {
      // Never respond -- the client's timeout should fire.
    });

    const report = await runDoctorChecks({
      baseUrl,
      timeoutMs: 50,
      gitCheckFn: okGitCheck,
    });
    const lmStudio = report.checks.find((c) => c.name === 'LM Studio');
    assert.equal(lmStudio.status, 'fail');
  });

  it('skips the model check when LM Studio is unreachable', async () => {
    const report = await runDoctorChecks({
      baseUrl: 'http://127.0.0.1:1/v1',
      gitCheckFn: okGitCheck,
    });
    assert.equal(
      report.checks.some((c) => c.name === 'model'),
      false,
    );
  });

  it('warns when LM Studio has no models loaded', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });

    const report = await runDoctorChecks({ baseUrl, gitCheckFn: okGitCheck });
    const model = report.checks.find((c) => c.name === 'model');
    assert.equal(model.status, 'warn');
    assert.equal(report.ok, true);
  });

  it('reports the resolved model id when one is loaded', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen/coder' }] }));
    });

    const report = await runDoctorChecks({ baseUrl, gitCheckFn: okGitCheck });
    const model = report.checks.find((c) => c.name === 'model');
    assert.equal(model.status, 'ok');
    assert.equal(model.detail, 'qwen/coder');
  });

  it('reports which provider it checked', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'a' }] }));
    });

    const report = await runDoctorChecks({ baseUrl, gitCheckFn: okGitCheck });
    assert.equal(
      report.checks.some((c) => c.name === 'LM Studio'),
      true,
    );
  });

  it('reports ollama as reachable with no API key required', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-coder:30b' }] }));
    });

    const report = await runDoctorChecks({
      provider: 'ollama',
      baseUrl,
      gitCheckFn: okGitCheck,
    });
    const ollama = report.checks.find((c) => c.name === 'Ollama');
    assert.equal(ollama.status, 'ok');
    assert.equal(report.ok, true);
  });

  it('reports a fail (not a crash) for openrouter when OPENROUTER_API_KEY is unset', async () => {
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const report = await runDoctorChecks({
        provider: 'openrouter',
        gitCheckFn: okGitCheck,
      });
      const openrouter = report.checks.find((c) => c.name === 'OpenRouter');
      assert.equal(openrouter.status, 'fail');
      assert.match(openrouter.detail, /OPENROUTER_API_KEY/);
      assert.equal(report.ok, false);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
    }
  });

  it('reports git ok when the check function succeeds', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'a' }] }));
    });

    const report = await runDoctorChecks({ baseUrl, gitCheckFn: okGitCheck });
    const git = report.checks.find((c) => c.name === 'git');
    assert.equal(git.status, 'ok');
  });

  it('warns when the git check function fails', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'a' }] }));
    });

    const report = await runDoctorChecks({
      baseUrl,
      gitCheckFn: missingGitCheck,
    });
    const git = report.checks.find((c) => c.name === 'git');
    assert.equal(git.status, 'warn');
    assert.equal(report.ok, true);
  });

  it('is false when any check fails, true when only warnings are present', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });

    const warnOnly = await runDoctorChecks({
      baseUrl,
      gitCheckFn: missingGitCheck,
    });
    assert.equal(warnOnly.ok, true);

    const withFail = await runDoctorChecks({
      baseUrl,
      nodeVersion: 'v18.0.0',
      gitCheckFn: missingGitCheck,
    });
    assert.equal(withFail.ok, false);
  });
});
