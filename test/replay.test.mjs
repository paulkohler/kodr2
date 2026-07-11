import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runReplay } from '../src/cli.mjs';

let cwd;
let server;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
  if (cwd) {
    await rm(cwd, { recursive: true, force: true });
    cwd = undefined;
  }
});

async function startTextOnlyModel() {
  const calls = [];
  server = createServer((req, res) => {
    if (req.url === '/api/v0/models') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"role":"assistant","content":"replayed"}}]}\n\n' +
          'data: [DONE]\n\n',
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, calls };
}

async function writeRunRecord(runDir, metadata) {
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, '2026-01-01T00-00-00-000Z.json'),
    JSON.stringify({ metadata, messages: [] }),
    'utf8',
  );
}

// Mirrors cli.test.mjs's own mockArgs: test doubles only ever populate the
// CliArgs fields a given test exercises; this cast documents that the
// object is deliberately partial rather than accidentally missing fields.
/**
 * @param {Partial<import('../src/cli.mjs').CliArgs>} partial
 * @returns {import('../src/cli.mjs').CliArgs}
 */
function mockArgs(partial) {
  return /** @type {import('../src/cli.mjs').CliArgs} */ (partial);
}

describe('runReplay', () => {
  it('fails with a usage message when no ref is given', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-replay-'));
    await runReplay(mockArgs({ prompt: null, cwd }));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it('fails when the referenced run has no recorded prompt', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-replay-'));
    await writeRunRecord(join(cwd, '.kodr', 'runs'), { cwd });

    await runReplay(mockArgs({ prompt: 'last', cwd }));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it('calls run() with the recorded prompt, cwd, model, and testCommand', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-replay-'));
    const model = await startTextOnlyModel();
    await writeRunRecord(join(cwd, '.kodr', 'runs'), {
      prompt: 'fix the failing test',
      cwd,
      baseUrl: model.baseUrl,
      model: 'recorded-model',
      testCommand: 'npm test',
    });

    await runReplay(mockArgs({ prompt: 'last', cwd, quiet: true }));

    assert.equal(model.calls.length, 1);
    const sent = model.calls[0];
    assert.equal(sent.model, 'recorded-model');
    assert.equal(
      sent.messages.some((m) => m.content?.includes('fix the failing test')),
      true,
    );
  });

  it('overrides the recorded model when --model is explicitly passed', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodr-replay-'));
    const model = await startTextOnlyModel();
    await writeRunRecord(join(cwd, '.kodr', 'runs'), {
      prompt: 'do the task',
      cwd,
      baseUrl: model.baseUrl,
      model: 'recorded-model',
    });

    await runReplay(
      mockArgs({
        prompt: 'last',
        cwd,
        quiet: true,
        model: 'override-model',
      }),
    );

    assert.equal(model.calls[0].model, 'override-model');
  });
});
