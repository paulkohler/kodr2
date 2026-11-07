/**
 * The #9 regression, as a composition.
 *
 * test/shell.test.mjs proves runShell reaps a backgrounded orphan and answers
 * an AbortSignal. Nothing proved that either reaches a *Stop hook*, and the
 * signal is optional at every layer it crosses (`options.signal` on
 * runStopHooks, on verify, on runShell), so a layer that forgets to pass it on
 * degrades silently to the leak. That is the shape #9 had: a process holding a
 * port for the rest of the session while every unit test passed.
 *
 * The gate here is the fixture, not the model. #9 was found only because a
 * model happened to write `cargo run &`; making the harness produce the orphan
 * turns a lucky find into a repeatable test.
 *
 * Every case asserts the server actually listened (`state.json` exists) before
 * asserting it died. Without that, a test that kills the tree before node even
 * starts passes for the wrong reason.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runStopHooks } from '../src/hooks.mjs';

const SERVER = `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const server = createServer((_req, res) => res.end('ok'));
server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.argv[2], JSON.stringify({
    pid: process.pid,
    port: server.address().port,
  }));
});
setInterval(() => {}, 1000);
`;

let dir;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/**
 * A workspace holding a server and a gate script that backgrounds it.
 * @param {string} tail What the gate does after backgrounding the server.
 *   `exit 0` orphans it (the #9 shape: sh is gone, so the ppid walk has
 *   nothing to find, but the inherited pipes stay open). `sleep 600` keeps
 *   the parent alive, the ordinary tree-kill shape.
 */
async function workspace(tail) {
  dir = await mkdtemp(join(tmpdir(), 'kodr-reap-'));
  const state = join(dir, 'state.json');
  writeFileSync(join(dir, 'server.mjs'), SERVER);
  writeFileSync(
    join(dir, 'gate.sh'),
    `#!/bin/sh\n"${process.execPath}" "${join(dir, 'server.mjs')}" "${state}" &\n` +
      `# give the server a moment to bind before the gate moves on\n` +
      `i=0\nwhile [ ! -f "${state}" ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.05; done\n${tail}\n`,
    { mode: 0o755 },
  );
  return { dir, state };
}

function readState(state) {
  assert.ok(
    existsSync(state),
    'the server never listened -- the case proves nothing about reaping',
  );
  return JSON.parse(readFileSync(state, 'utf8'));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canBind(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the pid to go, so a slow SIGTERM is not read as a leak. */
async function waitForDeath(pid, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await settle(50);
  }
  return false;
}

function gateHook(cwd, timeout) {
  return [
    {
      run: join(cwd, 'gate.sh'),
      name: 'gate',
      runWhenUnchanged: true,
      timeout,
    },
  ];
}

describe('a Stop hook that backgrounds a server (BACKLOG #9)', () => {
  it('reaps the orphan when the hook times out', async () => {
    const { dir: cwd, state } = await workspace('exit 0');

    const started = Date.now();
    const result = await runStopHooks(gateHook(cwd, 4000), cwd, {
      touchedWorkspace: true,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.passed, false);
    assert.ok(
      elapsed < 20000,
      `the timeout must answer rather than waiting on the orphan's pipes (took ${elapsed}ms)`,
    );

    const { pid, port } = readState(state);
    assert.ok(
      await waitForDeath(pid),
      `the backgrounded server survived the hook timeout (pid ${pid})`,
    );
    assert.equal(await canBind(port), true, `port ${port} is still held`);
  });

  it('reaps it when the gate keeps the shell alive too', async () => {
    // The ordinary tree shape: sh is still running, so both the group kill
    // and the ppid walk can reach the server. Distinct from the case above --
    // a revert that breaks only the orphan path leaves this one green.
    const { dir: cwd, state } = await workspace('sleep 600');

    const result = await runStopHooks(gateHook(cwd, 4000), cwd, {
      touchedWorkspace: true,
    });
    assert.equal(result.passed, false);

    const { pid, port } = readState(state);
    assert.ok(await waitForDeath(pid), `the server survived (pid ${pid})`);
    assert.equal(await canBind(port), true, `port ${port} is still held`);
  });

  it('reaps the orphan when the run is cancelled', async () => {
    // cancel.yaml recorded "an in-flight verify/Stop-hook child is not killed
    // by a cancel" as a known gap, then recorded it closed. This is what
    // tells you which is true.
    const { dir: cwd, state } = await workspace('exit 0');

    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 1200);
    const result = await runStopHooks(gateHook(cwd, 600000), cwd, {
      touchedWorkspace: true,
      signal: controller.signal,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.passed, false);
    assert.ok(
      elapsed < 20000,
      `the abort must answer rather than holding the full timeout (took ${elapsed}ms)`,
    );

    const { pid, port } = readState(state);
    assert.ok(
      await waitForDeath(pid),
      `the backgrounded server survived the cancel (pid ${pid})`,
    );
    assert.equal(await canBind(port), true, `port ${port} is still held`);
  });
});

describe('the #9 control -- the fixture really does leak', () => {
  it('the orphan outlives its own shell when nothing reaps it', async () => {
    // Run the same gate with no timeout and no signal, exactly as the harness
    // would before the fix. sh exits; the server keeps running and keeps the
    // port. If this ever stops holding, the cases above are passing because
    // the fixture stopped producing an orphan, not because reaping works.
    const { dir: cwd, state } = await workspace('exit 0');

    const child = spawn('/bin/sh', [join(cwd, 'gate.sh')], {
      cwd,
      detached: true,
      stdio: 'ignore',
    });
    await new Promise((resolve) => child.on('exit', resolve));

    const { pid, port } = readState(state);
    assert.equal(
      isAlive(pid),
      true,
      'the server should have outlived the shell that backgrounded it',
    );
    assert.equal(
      await canBind(port),
      false,
      'the orphan should still be holding its port',
    );

    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
    await waitForDeath(pid);
  });
});
