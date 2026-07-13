import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMMANDS,
  completeCommand,
  dispatchCommand,
  matchCommands,
  parseCommand,
} from '../src/tui-commands.mjs';
import { createTuiState, setRunning } from '../src/tui-state.mjs';

/** A session config bag with sensible defaults, overridable per test. */
function makeSession(overrides = {}) {
  return {
    provider: 'lmstudio',
    model: 'gemma',
    testCommand: undefined,
    approveCommands: false,
    reasoning: false,
    reasoningSupported: false,
    contextWindow: undefined,
    messages: [],
    lastPrompt: null,
    ...overrides,
  };
}

/** Plain (ANSI-stripped) scrollback, for substring assertions. */
function plain(state) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR escapes
  return state.scrollback.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
}

describe('parseCommand', () => {
  it('recognizes a known leading-slash word and splits off its argument', () => {
    assert.deepEqual(parseCommand('/model gpt-oss-20b'), {
      isCommand: true,
      name: 'model',
      arg: 'gpt-oss-20b',
    });
  });

  it('is case-insensitive on the command name', () => {
    assert.equal(parseCommand('/HELP').name, 'help');
  });

  it('returns handled=false shape for a non-slash input', () => {
    assert.equal(parseCommand('just a prompt').isCommand, false);
    assert.equal(parseCommand('  ').isCommand, false);
    assert.equal(parseCommand('/').isCommand, false);
  });

  it('leaves an empty argument when none is given', () => {
    assert.deepEqual(parseCommand('/cost'), {
      isCommand: true,
      name: 'cost',
      arg: '',
    });
  });
});

describe('matchCommands', () => {
  it('returns every primary command name for a bare slash', () => {
    assert.deepEqual(
      matchCommands('/'),
      COMMANDS.map((def) => def.names[0]),
    );
  });

  it('narrows to the primary names sharing the typed prefix', () => {
    assert.deepEqual(matchCommands('/c'), [
      'compact',
      'clear',
      'context',
      'cost',
    ]);
    assert.deepEqual(matchCommands('/comp'), ['compact']);
  });

  it('matches the command name case-insensitively', () => {
    assert.deepEqual(matchCommands('/HE'), ['help']);
  });

  it('stops suggesting once a space begins the argument', () => {
    assert.deepEqual(matchCommands('/model g'), []);
  });

  it('returns nothing for non-command input or an unmatched prefix', () => {
    assert.deepEqual(matchCommands('hello'), []);
    assert.deepEqual(matchCommands('/frobnicate'), []);
    assert.deepEqual(matchCommands(''), []);
  });

  it('only advertises primary names, not aliases', () => {
    // `/exit` is an alias of quit and `/cancel` of stop; neither is suggested.
    assert.deepEqual(matchCommands('/e'), []);
    assert.ok(!matchCommands('/c').includes('cancel'));
  });
});

describe('completeCommand', () => {
  it('completes a unique match to the full command with a trailing space', () => {
    assert.equal(completeCommand('/comp'), '/compact ');
    assert.equal(completeCommand('/di'), '/diff ');
  });

  it('completes to the longest prefix the matches share', () => {
    // /co matches compact, context, cost -> shared prefix "co".
    assert.equal(completeCommand('/co'), '/co');
    // /d matches diff, doctor -> shared prefix "d".
    assert.equal(completeCommand('/d'), '/d');
  });

  it('leaves non-command or unmatched input unchanged', () => {
    assert.equal(completeCommand('write a test'), 'write a test');
    assert.equal(completeCommand('/frobnicate'), '/frobnicate');
    assert.equal(completeCommand('/model gpt'), '/model gpt');
  });
});

describe('dispatchCommand', () => {
  it('does not handle a non-command (falls through to a prompt submit)', () => {
    const state = createTuiState();
    const outcome = dispatchCommand('add a test', state, makeSession());
    assert.equal(outcome.handled, false);
    assert.deepEqual(state.scrollback, []);
  });

  it('does not handle an unknown /word', () => {
    const state = createTuiState();
    const outcome = dispatchCommand('/frobnicate now', state, makeSession());
    assert.equal(outcome.handled, false);
    assert.deepEqual(state.scrollback, []);
  });

  it('echoes the command line into scrollback when handled', () => {
    const state = createTuiState();
    dispatchCommand('/cost', state, makeSession());
    assert.match(plain(state)[0], /›\s+\/cost/);
  });

  it('/help lists every recognized command', () => {
    const state = createTuiState();
    const outcome = dispatchCommand('/help', state, makeSession());
    assert.equal(outcome.effect, 'none');
    const text = plain(state).join('\n');
    for (const def of COMMANDS) {
      assert.ok(
        text.includes(`/${def.names[0]}`),
        `help should mention /${def.names[0]}`,
      );
    }
  });

  it('/clear returns effect=clear when idle, and is rejected while busy', () => {
    const idle = createTuiState();
    const session = makeSession({
      messages: [{ role: 'user', content: 'hi' }],
    });
    const cleared = dispatchCommand('/clear', idle, session);
    assert.equal(cleared.effect, 'clear');
    assert.deepEqual(session.messages, []);

    const busy = createTuiState();
    setRunning(busy, true);
    const rejected = dispatchCommand('/clear', busy, makeSession());
    assert.equal(rejected.effect, 'none');
    assert.match(plain(busy).join('\n'), /unavailable while a run is active/);
  });

  it('/retry with a prior prompt returns effect=start-run and the prompt', () => {
    const state = createTuiState();
    const outcome = dispatchCommand(
      '/retry',
      state,
      makeSession({ lastPrompt: 'fix the parser' }),
    );
    assert.equal(outcome.effect, 'start-run');
    assert.equal(outcome.prompt, 'fix the parser');
  });

  it('/retry with no prior prompt is a no-op with a notice', () => {
    const state = createTuiState();
    const outcome = dispatchCommand('/retry', state, makeSession());
    assert.equal(outcome.effect, 'none');
    assert.match(plain(state).join('\n'), /nothing to retry/);
  });

  it('/stop returns cancel-run while running and a notice when idle', () => {
    const running = createTuiState();
    setRunning(running, true);
    assert.equal(
      dispatchCommand('/stop', running, makeSession()).effect,
      'cancel-run',
    );

    const idle = createTuiState();
    const outcome = dispatchCommand('/cancel', idle, makeSession());
    assert.equal(outcome.effect, 'none');
    assert.match(plain(idle).join('\n'), /nothing is running/);
  });

  it('/model prints the current model, and sets it when idle', () => {
    const state = createTuiState({ model: 'gemma' });
    const session = makeSession({ model: 'gemma' });
    dispatchCommand('/model', state, session);
    assert.match(plain(state).join('\n'), /model: gemma/);

    dispatchCommand('/model gpt-oss-20b', state, session);
    assert.equal(session.model, 'gpt-oss-20b');
    assert.equal(state.model, 'gpt-oss-20b');
  });

  it('/model is rejected while a run is active', () => {
    const state = createTuiState();
    setRunning(state, true);
    const session = makeSession({ model: 'gemma' });
    dispatchCommand('/model other', state, session);
    assert.equal(session.model, 'gemma');
    assert.match(plain(state).join('\n'), /unavailable while a run is active/);
  });

  it('/context prints the window and token counts', () => {
    const state = createTuiState();
    state.tokensIn = 120;
    state.tokensOut = 34;
    dispatchCommand('/context', state, makeSession({ contextWindow: 8192 }));
    const text = plain(state).join('\n');
    assert.match(text, /context window: 8192/);
    assert.match(text, /120 in \/ 34 out/);
  });

  it('/cost prints the accumulated cost', () => {
    const state = createTuiState();
    state.cost = 0.1234;
    dispatchCommand('/cost', state, makeSession());
    assert.match(plain(state).join('\n'), /\$0\.1234/);
  });

  it('/approve toggles approveCommands and reports the new state', () => {
    const state = createTuiState();
    const session = makeSession({ approveCommands: false });
    dispatchCommand('/approve', state, session);
    assert.equal(session.approveCommands, true);
    assert.match(plain(state).join('\n'), /command approval on/);
  });

  it('/reasoning toggles when supported and notes when not', () => {
    const supported = makeSession({ reasoningSupported: true });
    const state = createTuiState();
    dispatchCommand('/reasoning', state, supported);
    assert.equal(supported.reasoning, true);

    const unsupported = makeSession({ reasoningSupported: false });
    const state2 = createTuiState();
    dispatchCommand('/reasoning', state2, unsupported);
    assert.equal(unsupported.reasoning, false);
    assert.match(plain(state2).join('\n'), /not supported/);
  });

  it('/test prints the command, and sets it when idle', () => {
    const state = createTuiState();
    const session = makeSession();
    dispatchCommand('/test', state, session);
    assert.match(plain(state).join('\n'), /verify command: \(none\)/);

    dispatchCommand('/test npm test', state, session);
    assert.equal(session.testCommand, 'npm test');
  });

  it('/history prints a compact conversation view, or notes when empty', () => {
    const empty = createTuiState();
    dispatchCommand('/history', empty, makeSession());
    assert.match(plain(empty).join('\n'), /no conversation yet/);

    const state = createTuiState();
    const session = makeSession({
      messages: [
        { role: 'system', content: 'you are kodr' },
        { role: 'user', content: 'add a flag' },
        { role: 'assistant', content: 'done' },
      ],
    });
    dispatchCommand('/history', state, session);
    const text = plain(state).join('\n');
    assert.match(text, /user: add a flag/);
    assert.match(text, /assistant: done/);
    assert.ok(!text.includes('you are kodr'), 'system message is omitted');
  });

  it('/diff and /doctor defer to the shell via an effect', () => {
    const s1 = createTuiState();
    assert.equal(dispatchCommand('/diff', s1, makeSession()).effect, 'diff');
    const s2 = createTuiState();
    assert.equal(
      dispatchCommand('/doctor', s2, makeSession()).effect,
      'doctor',
    );
  });

  it('/compact returns effect=compact when idle', () => {
    const state = createTuiState();
    assert.equal(
      dispatchCommand('/compact', state, makeSession()).effect,
      'compact',
    );
  });

  it('/quit returns effect=quit', () => {
    const state = createTuiState();
    assert.equal(dispatchCommand('/quit', state, makeSession()).effect, 'quit');
    assert.equal(
      dispatchCommand('/exit', createTuiState(), makeSession()).effect,
      'quit',
    );
  });
});
