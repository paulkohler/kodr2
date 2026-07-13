/**
 * The ACP front-end runtime (see specs/acp.yaml) — the imperative shell around
 * the pure protocol plumbing (acp-protocol.mjs) and the ACP reporter
 * (acp-reporter.mjs), the ACP analogue of runTui in src/tui.mjs.
 *
 * Responsibilities: frame line-delimited JSON-RPC on stdio, own the session
 * map, and drive one harness run() per session/prompt — streaming through the
 * ACP reporter and gating run_command through the client's
 * session/request_permission. The run loop itself is untouched; this is a
 * front-end and an output adapter.
 */

import { createInterface } from 'node:readline';
import { createAcpBackend } from './acp-backend.mjs';
import { createAcpReporter } from './acp-reporter.mjs';
import {
  createJsonRpcConnection,
  errorResponse,
  extractPromptText,
  initializeResult,
  PARSE_ERROR,
  stopReasonFor,
} from './acp-protocol.mjs';
import { run } from './harness.mjs';

/**
 * Wire an ACP agent onto a JSON-RPC connection. Registers the client->agent
 * method handlers and owns the in-memory session map. `runFn` is injectable so
 * tests can drive prompts without a real model.
 * @param {object} params
 * @param {ReturnType<typeof createJsonRpcConnection>} params.connection
 * @param {import('./harness.mjs').RunOptions} params.options - Base run options
 *   (provider/model/testCommand/…); cwd comes per-session from the client.
 * @param {typeof run} [params.runFn] - Harness entry point (overridable in tests)
 * @param {{ priorMessages: Array, priorFilesChanged: string[] }} [params.continueSeed] -
 *   A `kodr acp --continue` seed: the first session created resumes this prior
 *   run's conversation, then it's consumed (later sessions start fresh).
 * @returns {{ sessions: Map<string, object> }}
 */
export function createAcpAgent(params) {
  const { connection, options } = params;
  const runFn = params.runFn || run;
  const sessions = new Map();
  let sessionCount = 0;
  // Captured from the client's initialize request. Gates fs/* and terminal/*
  // delegation: an op the client didn't advertise stays local (see
  // src/acp-backend.mjs). Starts empty, so a client that never sends
  // capabilities gets today's fully-local behavior.
  const state = { clientCapabilities: {} };
  // A one-shot seed from `kodr acp --continue` (specs/acp.yaml): the first
  // session created resumes this prior run's conversation, then it's consumed
  // so later sessions in the process start fresh.
  let continueSeed = params.continueSeed || null;

  connection.setHandler('initialize', (reqParams) => {
    state.clientCapabilities = reqParams.clientCapabilities ?? {};
    return initializeResult();
  });

  // Kodr needs no ACP-level auth; provider credentials come from the
  // environment. A no-op success keeps compliant clients happy.
  connection.setHandler('authenticate', () => ({}));

  connection.setHandler('session/new', (reqParams) => {
    sessionCount++;
    const sessionId = `sess_${sessionCount}`;
    const seed = continueSeed;
    continueSeed = null;
    sessions.set(sessionId, {
      id: sessionId,
      cwd: reqParams.cwd,
      priorMessages: seed ? seed.priorMessages : null,
      priorFilesChanged: seed ? seed.priorFilesChanged : [],
      cancelled: false,
      controller: null,
    });
    return { sessionId };
  });

  connection.setHandler('session/prompt', (reqParams) =>
    handlePrompt({
      connection,
      options,
      runFn,
      sessions,
      reqParams,
      clientCapabilities: state.clientCapabilities,
    }),
  );

  // A notification: abort the in-flight run and mark the session so its prompt
  // resolves with the cancelled StopReason. The AbortController plumbed through
  // run() (specs/cancel.yaml) destroys the current model request's socket, so a
  // cancel lands mid-request rather than only when the run would have returned.
  connection.setHandler('session/cancel', (reqParams) => {
    const session = sessions.get(reqParams.sessionId);
    if (session) {
      session.cancelled = true;
      if (session.controller) {
        session.controller.abort();
      }
    }
  });

  return { sessions };
}

/**
 * Handle one session/prompt: run exactly one run() for the session, streaming
 * through the ACP reporter and gating run_command through the client, then
 * resolve with a StopReason.
 * @returns {Promise<{ stopReason: string }>}
 */
async function handlePrompt(ctx) {
  const { connection, options, runFn, sessions, reqParams } = ctx;
  const session = sessions.get(reqParams.sessionId);
  if (!session) {
    throw new Error(`unknown session: ${reqParams.sessionId}`);
  }
  session.cancelled = false;

  const prompt = extractPromptText(reqParams.prompt);
  const turnState = { toolCallId: null };
  const reporter = createAcpReporter(
    (update) =>
      connection.notify('session/update', {
        sessionId: session.id,
        update,
      }),
    turnState,
  );
  const confirm = (call) =>
    requestPermission({ connection, session, turnState, call });

  // Delegate the file/command tools' I/O to the editor for the capabilities it
  // advertised (fs/* reads and writes, terminal/* commands); anything it didn't
  // claim stays local. Built per prompt so it's bound to this session's id.
  const backend = createAcpBackend({
    connection,
    sessionId: session.id,
    capabilities: ctx.clientCapabilities,
  });

  // A fresh controller per prompt: session/cancel aborts exactly this run's
  // in-flight model request. Cleared in finally so a cancel arriving after the
  // prompt already resolved can't abort the next one.
  const controller = new AbortController();
  session.controller = controller;
  let result;
  try {
    result = await runFn(prompt, {
      ...options,
      cwd: session.cwd || options.cwd,
      reporter,
      confirm,
      approveCommands: true,
      priorMessages: session.priorMessages,
      priorFilesChanged: session.priorFilesChanged,
      quiet: false,
      signal: controller.signal,
      backend,
    });
  } finally {
    session.controller = null;
  }

  // Thread this run's messages (and touched files) into the next prompt so a
  // multi-turn ACP session continues the conversation — the same continuation
  // the CLI's --continue uses, and how a --continue seed carries forward.
  session.priorMessages = result.messages;
  session.priorFilesChanged = result.filesChanged || session.priorFilesChanged;

  return { stopReason: stopReasonFor(result.stoppedReason, session.cancelled) };
}

/**
 * Ask the client to authorize a run_command via session/request_permission.
 * Resolves { approved } for the tool loop's approval gate.
 * @returns {Promise<{ approved: boolean }>}
 */
async function requestPermission(ctx) {
  const { connection, session, turnState, call } = ctx;
  try {
    const outcome = await connection.request('session/request_permission', {
      sessionId: session.id,
      toolCall: {
        toolCallId: turnState.toolCallId,
        title: call.name,
        kind: 'execute',
        status: 'pending',
        rawInput: call.args,
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    return { approved: isAllowed(outcome) };
  } catch {
    // A client that fails to answer a permission request denies by default:
    // the confirm channel must resolve, never reject, or a flaky client RPC
    // would crash the whole run instead of just refusing one command.
    return { approved: false };
  }
}

/**
 * Whether a session/request_permission outcome granted the call.
 * @param {{ outcome?: { outcome?: string, optionId?: string } }} [result]
 * @returns {boolean}
 */
function isAllowed(result) {
  const outcome = result && result.outcome;
  if (!outcome || outcome.outcome !== 'selected') {
    return false;
  }
  return outcome.optionId === 'allow';
}

/**
 * Run the ACP front-end over stdio. Resolves when stdin closes.
 * @param {import('./harness.mjs').RunOptions & { continueSeed?: { priorMessages: Array, priorFilesChanged: string[] } }} options -
 *   Base run options, optionally carrying a `kodr acp --continue` seed (pulled
 *   out before the rest is used as per-run options).
 * @param {object} [io] - Injectable streams (default process.stdin/stdout)
 * @param {NodeJS.ReadableStream} [io.input]
 * @param {{ write: (text: string) => void }} [io.output]
 * @returns {Promise<void>}
 */
export function runAcp(options, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;

  // continueSeed is a launch-time concern, not a per-run option -- pull it out
  // so it doesn't ride along into every run() call via handlePrompt's spread.
  const { continueSeed, ...runOptions } = options;

  const connection = createJsonRpcConnection({
    send: (message) => output.write(`${JSON.stringify(message)}\n`),
  });
  createAcpAgent({ connection, options: runOptions, continueSeed });

  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        output.write(
          `${JSON.stringify(errorResponse(null, PARSE_ERROR, 'parse error'))}\n`,
        );
        return;
      }
      // receive() is async (a prompt drives a whole run); failures inside a
      // request are already turned into JSON-RPC error responses by the
      // connection, so nothing here needs to await or catch.
      connection.receive(message);
    });
    rl.on('close', resolve);
  });
}
