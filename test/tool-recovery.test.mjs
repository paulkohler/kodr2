import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  recoverTextToolCall,
  recoverToolCalls,
  recoverToolName,
} from '../src/tool-recovery.mjs';

describe('recoverTextToolCall (back-compatible single call)', () => {
  it('recovers a single name[ARGS]{...} call', () => {
    const call = recoverTextToolCall(
      'edit_file[ARGS]{"path":"a.mjs","old_string":"x","new_string":"y"}',
    );
    assert.deepEqual(call, {
      name: 'edit_file',
      args: { path: 'a.mjs', old_string: 'x', new_string: 'y' },
    });
  });

  it('rejects non-object args', () => {
    assert.equal(recoverTextToolCall('read_file[ARGS][]'), null);
  });

  it('does not recover a call embedded in prose', () => {
    assert.equal(recoverTextToolCall('please run edit_file[ARGS]{}'), null);
  });

  it('returns null for plain prose', () => {
    assert.equal(recoverTextToolCall('Sure, let me read that file.'), null);
  });
});

describe('recoverToolCalls — Mistral [TOOL_CALLS] framing', () => {
  it('strips a leading token and ignores echoed text before it', () => {
    // The exact shape that lost a README write in the dogfood: an echoed prior
    // result, then the framing token, then the real call.
    const content =
      '{"written":true,"path":"server.js"}[TOOL_CALLS]write_file{"path":"README.md","content":"# Hi"}';
    assert.deepEqual(recoverToolCalls(content), [
      { name: 'write_file', args: { path: 'README.md', content: '# Hi' } },
    ]);
  });

  it('recovers name[ARGS]{...} after the token', () => {
    assert.deepEqual(
      recoverToolCalls('[TOOL_CALLS]read_file[ARGS]{"path":"a.txt"}'),
      [{ name: 'read_file', args: { path: 'a.txt' } }],
    );
  });

  it('recovers a JSON array as multiple calls', () => {
    const content =
      '[TOOL_CALLS][{"name":"list_files","arguments":{}},{"name":"read_file","arguments":{"path":"a.txt"}}]';
    assert.deepEqual(recoverToolCalls(content), [
      { name: 'list_files', args: {} },
      { name: 'read_file', args: { path: 'a.txt' } },
    ]);
  });

  it('recovers multiple separate tokens', () => {
    const content =
      '[TOOL_CALLS]list_files{}[TOOL_CALLS]read_file{"path":"a.txt"}';
    assert.deepEqual(recoverToolCalls(content), [
      { name: 'list_files', args: {} },
      { name: 'read_file', args: { path: 'a.txt' } },
    ]);
  });
});

describe('recoverToolCalls — JSON and fenced forms', () => {
  it('recovers a bare JSON object with name/arguments', () => {
    assert.deepEqual(
      recoverToolCalls('{"name":"read_file","arguments":{"path":"a.txt"}}'),
      [{ name: 'read_file', args: { path: 'a.txt' } }],
    );
  });

  it('recovers JSON using key aliases (tool/parameters)', () => {
    assert.deepEqual(
      recoverToolCalls('{"tool":"read_file","parameters":{"path":"a.txt"}}'),
      [{ name: 'read_file', args: { path: 'a.txt' } }],
    );
  });

  it('parses a JSON-string arguments value', () => {
    assert.deepEqual(
      recoverToolCalls(
        '{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}',
      ),
      [{ name: 'read_file', args: { path: 'a.txt' } }],
    );
  });

  it('recovers a call from a fenced json block', () => {
    const content =
      'Here you go:\n```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```';
    assert.deepEqual(recoverToolCalls(content), [
      { name: 'read_file', args: { path: 'a.txt' } },
    ]);
  });

  it('ignores trailing text after the call JSON', () => {
    assert.deepEqual(
      recoverToolCalls('write_file{"path":"a.txt","content":"x"} done!'),
      [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }],
    );
  });

  it('returns an empty array for plain prose', () => {
    assert.deepEqual(recoverToolCalls('I will now read the file.'), []);
  });

  it('drops a JSON object whose name is not a tool-name shape', () => {
    assert.deepEqual(
      recoverToolCalls('{"name":"Read File","arguments":{}}'),
      [],
    );
  });
});

describe('recoverToolName — polluted native tool-call names', () => {
  it('returns a clean name unchanged', () => {
    assert.equal(recoverToolName('write_file'), 'write_file');
  });

  it('extracts the real name after a [TOOL_CALLS] token', () => {
    assert.equal(
      recoverToolName(
        '{"written":true,"path":"server.js"}[TOOL_CALLS]write_file',
      ),
      'write_file',
    );
  });

  it('takes the leading identifier after the token', () => {
    assert.equal(recoverToolName('[TOOL_CALLS]read_file[ARGS]'), 'read_file');
  });

  it('leaves an unframed odd name unchanged for dispatch to reject', () => {
    assert.equal(recoverToolName('totally.invalid'), 'totally.invalid');
  });
});
