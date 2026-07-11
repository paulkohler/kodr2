import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  appendMemoryNotes,
  isMemoryEnabled,
  memoryPromptTimeoutMs,
  memoryReserveFraction,
  memorySizeCap,
  memorySizeNotice,
  promptYesNo,
  readMemory,
  retrospectiveBudgetMs,
  runMemoryRetrospective,
  writeMemoryProposal,
} from '../src/memory.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-memory-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Mirrors tool-loop.test.mjs's/review.test.mjs's own scriptedClient.
/**
 * @param {Array<object>} responses
 * @returns {import('../src/provider.mjs').Provider & { calls: Array<any> }}
 */
function scriptedClient(responses) {
  const calls = [];
  let i = 0;
  return /** @type {import('../src/provider.mjs').Provider & { calls: Array<any> }} */ (
    /** @type {any} */ ({
      calls,
      async chat(params) {
        calls.push(params);
        const response = responses[Math.min(i, responses.length - 1)];
        i++;
        return response;
      },
    })
  );
}

function finalTurn(text, usage = { prompt: 2, completion: 3 }) {
  return { message: { role: 'assistant', content: text }, usage };
}

function baseMessages() {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'do the task' },
    { role: 'assistant', content: 'done' },
  ];
}

describe('runMemoryRetrospective', () => {
  it('is skipped when the run made no tool calls', async () => {
    const client = scriptedClient([finalTurn('should not be called')]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 0,
      runsDir: tmpDir,
    });
    assert.deepEqual(result, { proposed: false });
    assert.equal(client.calls.length, 0);
  });

  it('is skipped when remaining budget (after memoryReserve) is exhausted', async () => {
    const client = scriptedClient([finalTurn('should not be called')]);
    const startedAt = new Date(Date.now() - 10_000);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      startedAt,
      maxRunMs: 1000, // already elapsed
      memoryReserve: 0.1,
    });
    assert.deepEqual(result, { proposed: false });
    assert.equal(client.calls.length, 0);
  });

  it('receives timeoutMs capped to the remaining run budget', async () => {
    const client = scriptedClient([finalTurn('No findings.')]);
    const startedAt = new Date(Date.now() - 100);
    await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      startedAt,
      maxRunMs: 10_000,
      memoryReserve: 0.1,
    });
    assert.equal(client.calls.length, 1);
    const { timeoutMs } = client.calls[0];
    // ~9000 remaining * 0.9 reserve-adjusted, allowing for elapsed ms.
    assert.ok(timeoutMs > 7000 && timeoutMs < 9500, `got ${timeoutMs}`);
  });

  it('system prompt forbids tool calls and secrets and states notes are saved verbatim', async () => {
    const client = scriptedClient([finalTurn('No findings.')]);
    await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
    });
    const system = client.calls[0].messages.find(
      (m) => m.role === 'system',
    ).content;
    assert.match(system, /no tools in this step/);
    assert.match(system, /plain text only/);
    assert.match(system, /saved verbatim/);
    assert.match(system, /secrets, tokens, or credentials/);
    assert.match(system, /No findings\./);
  });

  it('treats "No findings." as nothing to propose', async () => {
    const client = scriptedClient([finalTurn('No findings.')]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
    });
    assert.equal(result.proposed, true);
    assert.equal(result.notes, '');
    assert.equal(result.applied, false);
    assert.equal(result.proposalPath, null);
    assert.equal(await readMemory(tmpDir), null);
  });

  it('attended session prompts, prints the proposal, and applies on a "y" response', async () => {
    const client = scriptedClient([
      finalTurn('Use npm test, not node --test directly.'),
    ]);
    let promptedWith;
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: true,
      promptYesNoFn: async (question) => {
        promptedWith = question;
        return true;
      },
    });

    assert.match(promptedWith, /Use npm test, not node --test directly\./);
    assert.match(promptedWith, /Keep these notes for future runs\?/);
    assert.equal(result.applied, true);
    assert.equal(result.proposalPath, null);
    const memory = await readMemory(tmpDir);
    assert.match(memory, /Use npm test, not node --test directly\./);
  });

  it('attended session discards on a "n" (or any non-"y") response', async () => {
    const client = scriptedClient([finalTurn('some note')]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: true,
      promptYesNoFn: async () => false,
    });

    assert.equal(result.applied, false);
    assert.equal(await readMemory(tmpDir), null);
  });

  it('unattended session writes the proposal file and leaves MEMORY.md untouched', async () => {
    const client = scriptedClient([finalTurn('some note')]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: false,
    });

    assert.equal(result.applied, false);
    assert.ok(result.proposalPath);
    const proposalContent = await readFile(result.proposalPath, 'utf8');
    assert.equal(proposalContent, 'some note');
    assert.equal(await readMemory(tmpDir), null);
  });

  it('reports retries used by its chat call', async () => {
    const client = scriptedClient([{ ...finalTurn('some note'), retries: 1 }]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: false,
    });

    assert.equal(result.retries, 1);
  });

  it('reports retries from the error when the retrospective call ultimately fails', async () => {
    const client = /** @type {import('../src/provider.mjs').Provider} */ (
      /** @type {any} */ ({
        async chat() {
          const err = /** @type {Error & { retries: number }} */ (
            new Error('model offline')
          );
          err.retries = 1;
          throw err;
        },
      })
    );
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: false,
    });

    assert.equal(result.retries, 1);
  });

  it('--memory-auto-apply applies without prompting, even when unattended', async () => {
    const client = scriptedClient([finalTurn('auto-applied note')]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: false,
      autoApply: true,
    });

    assert.equal(result.applied, true);
    assert.equal(result.proposalPath, null);
    const memory = await readMemory(tmpDir);
    assert.match(memory, /auto-applied note/);
  });

  it('--memory-auto-apply still writes to MEMORY.md under noSave -- noSave only skips the runsDir proposal-file write, not the whole feature', async () => {
    const client = scriptedClient([finalTurn('auto-applied under noSave')]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: false,
      autoApply: true,
      noSave: true,
    });

    assert.equal(result.applied, true);
    const memory = await readMemory(tmpDir);
    assert.match(memory, /auto-applied under noSave/);
  });

  it('unattended session under noSave returns the notes without writing a proposal file', async () => {
    const client = scriptedClient([finalTurn('unattended note under noSave')]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: false,
      noSave: true,
    });

    assert.equal(result.notes, 'unattended note under noSave');
    assert.equal(result.applied, false);
    assert.equal(result.proposalPath, null);
    assert.equal((await readdir(tmpDir)).length, 0);
  });

  it('falls back to a persisted proposal when the attended prompt times out (no real answer obtained)', async () => {
    const client = scriptedClient([
      finalTurn('note pending an unanswered prompt'),
    ]);
    const result = await runMemoryRetrospective({
      client,
      modelId: 'test',
      messages: baseMessages(),
      cwd: tmpDir,
      toolTurns: 2,
      runsDir: tmpDir,
      attended: true,
      promptYesNoFn: async () => null, // simulates promptYesNo's own timeout
    });

    assert.equal(result.applied, false);
    assert.ok(result.proposalPath, 'expected a fallback proposal file');
    const proposalContent = await readFile(result.proposalPath, 'utf8');
    assert.equal(proposalContent, 'note pending an unanswered prompt');
    assert.equal(await readMemory(tmpDir), null);
  });
});

describe('promptYesNo', () => {
  it('resolves to null (not a hang) when stdin never sends an answer', async () => {
    const input = new Readable({ read() {} }); // never emits data, never ends
    const output = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
    });

    const start = Date.now();
    const result = await promptYesNo('Keep these notes? [y/N] ', {
      input,
      output,
      timeoutMs: 200,
    });
    assert.equal(result, null);
    assert.ok(Date.now() - start < 2000, 'should not have hung');
  });
});

describe('memoryPromptTimeoutMs', () => {
  const envKey = 'KODR_MEMORY_PROMPT_TIMEOUT_MS';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('prefers an explicit option', () => {
    assert.equal(memoryPromptTimeoutMs(1234), 1234);
  });

  it('falls back to the default when nothing is set', () => {
    delete process.env[envKey];
    assert.equal(memoryPromptTimeoutMs(undefined), 300_000);
  });
});

describe('appendMemoryNotes concurrency', () => {
  it('never loses an entry when two calls race -- both land, via atomic O_APPEND rather than read-then-write', async () => {
    await writeFile(join(tmpDir, 'MEMORY.md'), 'pre-existing human note\n');
    await Promise.all([
      appendMemoryNotes(tmpDir, 'concurrent note A'),
      appendMemoryNotes(tmpDir, 'concurrent note B'),
    ]);
    const content = await readMemory(tmpDir);
    assert.match(content, /pre-existing human note/);
    assert.match(content, /concurrent note A/);
    assert.match(content, /concurrent note B/);
  });
});

describe('appendMemoryNotes', () => {
  it('appends to existing MEMORY.md content rather than replacing it', async () => {
    await writeFile(join(tmpDir, 'MEMORY.md'), 'existing human-written note\n');
    await appendMemoryNotes(tmpDir, 'new proposed note');
    const content = await readFile(join(tmpDir, 'MEMORY.md'), 'utf8');
    assert.match(content, /existing human-written note/);
    assert.match(content, /new proposed note/);
  });

  it('creates MEMORY.md when none exists yet', async () => {
    await appendMemoryNotes(tmpDir, 'first note');
    const content = await readFile(join(tmpDir, 'MEMORY.md'), 'utf8');
    assert.match(content, /first note/);
  });
});

describe('readMemory', () => {
  it('returns null when MEMORY.md does not exist', async () => {
    assert.equal(await readMemory(tmpDir), null);
  });

  it('returns trimmed file content when it exists', async () => {
    await writeFile(join(tmpDir, 'MEMORY.md'), '  some notes  \n');
    assert.equal(await readMemory(tmpDir), 'some notes');
  });
});

describe('writeMemoryProposal', () => {
  it('writes a flat file into runsDir, peer to run transcripts', async () => {
    const path = await writeMemoryProposal(tmpDir, 'proposed notes');
    assert.match(path, /\.memory-proposal\.md$/);
    const content = await readFile(path, 'utf8');
    assert.equal(content, 'proposed notes');
    const entries = await readdir(tmpDir);
    assert.ok(entries.some((e) => e.endsWith('.memory-proposal.md')));
  });
});

describe('memorySizeNotice', () => {
  it('returns null when content is under the cap', () => {
    assert.equal(memorySizeNotice('short', 100), null);
  });

  it('returns null when content is null', () => {
    assert.equal(memorySizeNotice(null, 100), null);
  });

  it('returns a notice when content exceeds the cap, without truncating', () => {
    const content = 'x'.repeat(101);
    const notice = memorySizeNotice(content, 100);
    assert.match(notice, /over the 100-character cap/);
  });
});

describe('isMemoryEnabled', () => {
  const envKey = 'KODR_MEMORY';
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalEnv;
    }
  });

  it('is off by default', () => {
    delete process.env[envKey];
    assert.equal(isMemoryEnabled(undefined), false);
  });

  it('is on when the option is true', () => {
    delete process.env[envKey];
    assert.equal(isMemoryEnabled(true), true);
  });

  it('is on via KODR_MEMORY', () => {
    process.env[envKey] = '1';
    assert.equal(isMemoryEnabled(undefined), true);
  });
});

describe('memoryReserveFraction', () => {
  it('defaults to 0.1', () => {
    delete process.env.KODR_MEMORY_RESERVE;
    assert.equal(memoryReserveFraction(undefined), 0.1);
  });

  it('clamps to [0, 0.9]', () => {
    delete process.env.KODR_MEMORY_RESERVE;
    assert.equal(memoryReserveFraction(-1), 0);
    assert.equal(memoryReserveFraction(5), 0.9);
  });

  it('prefers an explicit option over the environment', () => {
    process.env.KODR_MEMORY_RESERVE = '0.4';
    assert.equal(memoryReserveFraction(0.2), 0.2);
    delete process.env.KODR_MEMORY_RESERVE;
  });
});

describe('memorySizeCap', () => {
  it('prefers an explicit option', () => {
    assert.equal(memorySizeCap(1234), 1234);
  });

  it('falls back to the default when nothing is set', () => {
    delete process.env.KODR_MEMORY_SIZE_CAP;
    assert.equal(memorySizeCap(undefined), 8_000);
  });
});

describe('retrospectiveBudgetMs', () => {
  it('returns undefined when no run budget is set', () => {
    assert.equal(retrospectiveBudgetMs(new Date(), 0, 0.1), undefined);
  });

  it('reserves the given fraction of the remaining budget', () => {
    const startedAt = new Date();
    const budget = retrospectiveBudgetMs(startedAt, 1000, 0.1);
    assert.ok(budget <= 900 && budget >= 850, `got ${budget}`);
  });
});
