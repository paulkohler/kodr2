/**
 * TUI slash-command dispatch (see specs/tui-slash-commands.yaml) -- pure.
 *
 * A slash command is a session meta-command: it acts on the conversation, the
 * per-session config, or the view, rather than being sent to the model as a
 * prompt. This module is the parse-and-dispatch layer the TUI input loop calls
 * before submit(); it mutates the shared TUI state (scrollback, and a small
 * `session` config bag) and returns an `effect` telling the imperative shell
 * (src/tui.mjs) what to do next -- quit, start a run, cancel one, compact, or
 * shell out for a diff/doctor report. Kept free of terminal or async I/O so
 * the whole command set unit-tests without a TTY, mirroring the
 * tui-state / tui-render split.
 */

import { formatNotice } from './format.mjs';
import { pushLine } from './tui-state.mjs';

/** Cyan caret an echoed prompt or command line carries in scrollback. */
export const PROMPT_ECHO = '\x1b[36m›\x1b[0m';

/**
 * @typedef {object} TuiSession
 * @property {string} provider - Resolved provider name (display/print only)
 * @property {string} model - Active model id (mutable via /model)
 * @property {string} [testCommand] - Verify command (mutable via /test)
 * @property {boolean} approveCommands - Command-approval toggle (/approve)
 * @property {boolean} reasoning - Reasoning-tokens toggle (/reasoning)
 * @property {boolean} reasoningSupported - Whether the provider supports it
 * @property {number} [contextWindow] - Configured window, if any (/context)
 * @property {object[]} messages - Current conversation, for /history
 * @property {string|null} lastPrompt - Last task prompt, for /retry
 */

/**
 * @typedef {object} CommandOutcome
 * @property {boolean} handled - True when a known command was dispatched
 * @property {string} effect - none | quit | clear | start-run | cancel-run | compact | diff | doctor
 * @property {string} [prompt] - Prompt to (re-)run, for effect start-run
 */

/**
 * The command table: primary name first, then aliases. Exported so /help and
 * tests enumerate the exact recognized set.
 */
export const COMMANDS = [
  { names: ['help', '?'], summary: 'list these commands', run: cmdHelp },
  {
    names: ['compact'],
    summary: 'compress the conversation and continue',
    run: cmdCompact,
  },
  {
    names: ['clear', 'new'],
    summary: 'start a fresh conversation',
    run: cmdClear,
  },
  { names: ['retry'], summary: 're-run the last prompt fresh', run: cmdRetry },
  {
    names: ['stop', 'cancel'],
    summary: 'abort the running turn',
    run: cmdStop,
  },
  {
    names: ['model'],
    summary: 'show or set the model (/model <id>)',
    run: cmdModel,
  },
  { names: ['provider'], summary: 'show the provider', run: cmdProvider },
  {
    names: ['context', 'tokens'],
    summary: 'show context window and token counts',
    run: cmdContext,
  },
  { names: ['cost'], summary: 'show accumulated cost', run: cmdCost },
  {
    names: ['diff'],
    summary: 'show the git diff of this session',
    run: cmdDiff,
  },
  {
    names: ['history', 'messages'],
    summary: 'show the conversation so far',
    run: cmdHistory,
  },
  {
    names: ['test'],
    summary: 'show or set the verify command (/test <cmd>)',
    run: cmdTest,
  },
  {
    names: ['approve'],
    summary: 'toggle per-command approval',
    run: cmdApprove,
  },
  {
    names: ['reasoning'],
    summary: 'toggle reasoning tokens',
    run: cmdReasoning,
  },
  { names: ['doctor'], summary: 'run preflight checks', run: cmdDoctor },
  { names: ['quit', 'exit'], summary: 'leave the TUI', run: cmdQuit },
];

const BY_NAME = new Map();
for (const def of COMMANDS) {
  for (const name of def.names) {
    BY_NAME.set(name, def);
  }
}

/**
 * Parse the input's command shape. Recognizes a leading `/word`; the word
 * (lowercased, without the slash) is the name and the remainder (trimmed) is
 * the argument. Says nothing about whether the name is a known command.
 * @param {string} input
 * @returns {{ isCommand: boolean, name: string, arg: string }}
 */
export function parseCommand(input) {
  const trimmed = (input || '').trim();
  if (!trimmed.startsWith('/') || trimmed.length < 2) {
    return { isCommand: false, name: '', arg: '' };
  }
  const rest = trimmed.slice(1);
  const space = rest.search(/\s/);
  if (space === -1) {
    return { isCommand: true, name: rest.toLowerCase(), arg: '' };
  }
  return {
    isCommand: true,
    name: rest.slice(0, space).toLowerCase(),
    arg: rest.slice(space + 1).trim(),
  };
}

/**
 * Suggestions for a partially-typed command word: the primary command names
 * whose name begins with what has been typed so far. Empty unless the input is
 * a bare-or-partial `/word` with no argument yet -- once a space is typed the
 * command word is settled, so the hint reverts. Only primary names are
 * returned (aliases still work, they just aren't advertised), keeping the
 * suggestion line short. Pure: used by tui-render.mjs to draw the hint row.
 * @param {string} input - The current input-box contents
 * @returns {string[]} Matching primary names, without the leading slash
 */
export function matchCommands(input) {
  const text = input || '';
  if (!text.startsWith('/') || /\s/.test(text)) {
    return [];
  }
  const prefix = text.slice(1).toLowerCase();
  const out = [];
  for (const def of COMMANDS) {
    if (def.names[0].startsWith(prefix)) {
      out.push(def.names[0]);
    }
  }
  return out;
}

/**
 * Complete a partially-typed command on Tab. Returns the input rewritten to the
 * best completion: to the sole matching command (with a trailing space, ready
 * for an argument) when exactly one matches, otherwise to the longest prefix
 * the matches share -- which may equal the input (nothing more to complete;
 * the hint row keeps listing the candidates). Non-command input is returned
 * unchanged. Pure, like matchCommands.
 * @param {string} input - The current input-box contents
 * @returns {string} The completed input
 */
export function completeCommand(input) {
  const matches = matchCommands(input);
  if (matches.length === 0) {
    return input;
  }
  if (matches.length === 1) {
    return `/${matches[0]} `;
  }
  return `/${commonPrefix(matches)}`;
}

/** The longest string that every name begins with. */
function commonPrefix(names) {
  let prefix = names[0];
  for (const name of names) {
    while (!name.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

/**
 * Dispatch a slash command. Returns handled=false for a non-command or an
 * unknown `/word` (the shell then submits it to the model as an ordinary
 * prompt -- unknown commands are never swallowed). A handled command echoes
 * its own line into scrollback, mutates state/session, and returns an effect.
 * @param {string} input - Raw input-box contents at submit time
 * @param {import('./tui-state.mjs').TuiState} state - Mutated
 * @param {TuiSession} session - Mutated for config commands
 * @returns {CommandOutcome}
 */
export function dispatchCommand(input, state, session) {
  const parsed = parseCommand(input);
  if (!parsed.isCommand) {
    return { handled: false, effect: 'none' };
  }
  const def = BY_NAME.get(parsed.name);
  if (!def) {
    return { handled: false, effect: 'none' };
  }
  pushLine(state, `${PROMPT_ECHO} ${input.trim()}`);
  const result = def.run(state, parsed.arg, session) || {};
  return {
    handled: true,
    effect: result.effect || 'none',
    prompt: result.prompt,
  };
}

function cmdHelp(state) {
  pushLine(state, 'commands:');
  for (const def of COMMANDS) {
    const names = def.names.map((name) => `/${name}`).join(', ');
    pushLine(state, `  ${names} — ${def.summary}`);
  }
  return { effect: 'none' };
}

function cmdCompact(state) {
  if (state.running) {
    return rejectWhileBusy(state, '/compact');
  }
  return { effect: 'compact' };
}

function cmdClear(state, _arg, session) {
  if (state.running) {
    return rejectWhileBusy(state, '/clear');
  }
  session.messages = [];
  note(state, 'conversation cleared; the next prompt starts fresh');
  return { effect: 'clear' };
}

function cmdRetry(state, _arg, session) {
  if (state.running) {
    return rejectWhileBusy(state, '/retry');
  }
  if (!session.lastPrompt) {
    note(state, 'nothing to retry yet');
    return { effect: 'none' };
  }
  return { effect: 'start-run', prompt: session.lastPrompt };
}

function cmdStop(state) {
  if (!state.running) {
    note(state, 'nothing is running');
    return { effect: 'none' };
  }
  note(state, 'stopping the current run…');
  return { effect: 'cancel-run' };
}

function cmdModel(state, arg, session) {
  if (!arg) {
    note(state, `model: ${session.model}`);
    return { effect: 'none' };
  }
  if (state.running) {
    return rejectWhileBusy(state, '/model');
  }
  session.model = arg;
  state.model = arg;
  note(state, `model set to ${arg}`);
  return { effect: 'none' };
}

function cmdProvider(state, _arg, session) {
  note(state, `provider: ${session.provider}`);
  return { effect: 'none' };
}

function cmdContext(state, _arg, session) {
  const window = session.contextWindow
    ? String(session.contextWindow)
    : 'auto-detected';
  note(
    state,
    `context window: ${window} · tokens: ${state.tokensIn} in / ${state.tokensOut} out`,
  );
  return { effect: 'none' };
}

function cmdCost(state) {
  note(state, `cost: $${state.cost.toFixed(4)}`);
  return { effect: 'none' };
}

function cmdDiff() {
  return { effect: 'diff' };
}

function cmdHistory(state, _arg, session) {
  const messages = (session.messages || []).filter(
    (message) => message.role !== 'system',
  );
  if (messages.length === 0) {
    note(state, 'no conversation yet');
    return { effect: 'none' };
  }
  for (const message of messages) {
    pushLine(state, formatHistoryEntry(message));
  }
  return { effect: 'none' };
}

function cmdTest(state, arg, session) {
  if (!arg) {
    note(state, `verify command: ${session.testCommand || '(none)'}`);
    return { effect: 'none' };
  }
  if (state.running) {
    return rejectWhileBusy(state, '/test');
  }
  session.testCommand = arg;
  note(state, `verify command set to ${arg}`);
  return { effect: 'none' };
}

function cmdApprove(state, _arg, session) {
  session.approveCommands = !session.approveCommands;
  note(state, `command approval ${onOff(session.approveCommands)}`);
  return { effect: 'none' };
}

function cmdReasoning(state, _arg, session) {
  if (!session.reasoningSupported) {
    note(state, `reasoning is not supported by provider ${session.provider}`);
    return { effect: 'none' };
  }
  session.reasoning = !session.reasoning;
  note(state, `reasoning ${onOff(session.reasoning)}`);
  return { effect: 'none' };
}

function cmdDoctor() {
  return { effect: 'doctor' };
}

function cmdQuit() {
  return { effect: 'quit' };
}

/** Reject a config command that can't run while a turn is active. */
function rejectWhileBusy(state, what) {
  note(state, `${what} is unavailable while a run is active`);
  return { effect: 'none' };
}

function note(state, text) {
  pushLine(state, formatNotice(text));
}

function onOff(value) {
  if (value) {
    return 'on';
  }
  return 'off';
}

/** One compact scrollback line for a conversation message. */
function formatHistoryEntry(message) {
  const role = message.role || '?';
  const text = historyText(message);
  const clipped = text.length > 100 ? `${text.slice(0, 100)}…` : text;
  return `${role}: ${clipped}`;
}

function historyText(message) {
  if (typeof message.content === 'string' && message.content.trim()) {
    return collapse(message.content);
  }
  if (Array.isArray(message.content)) {
    const joined = message.content
      .map((part) => partText(part))
      .join(' ')
      .trim();
    if (joined) {
      return collapse(joined);
    }
  }
  if (message.tool_calls?.length) {
    const n = message.tool_calls.length;
    return `(${n} tool call${n === 1 ? '' : 's'})`;
  }
  return '(empty)';
}

function partText(part) {
  if (typeof part === 'string') {
    return part;
  }
  return part?.text || '';
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}
