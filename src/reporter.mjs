/**
 * The reporter — the run's one-way output channel.
 *
 * Every terminal write the harness makes during a run goes through a reporter
 * instead of a bare process.stdout/stderr.write, so the presentation layer is
 * decoupled from the orchestration. This mirrors the debug-log precedent
 * (src/debug-log.mjs): a factory returning a callback sink, threaded through
 * the run — generalized here from one callback to a small object of methods.
 *
 * A reporter is *total*: every method below always exists as a function, so
 * call sites never guard with `if (reporter)`. Suppression (`--quiet`,
 * `--json`) is expressed by selecting the null reporter, not by scattering
 * `if (!quiet)` checks through the loop. That is the whole point — the null
 * reporter subsumes what `quiet` used to gate.
 *
 * Three reporters ship here:
 *   - createNullReporter()     — all methods no-op (quiet/json).
 *   - createTerminalReporter() — today's exact stdout/stderr split, using the
 *                                pure string builders in format.mjs.
 *   - createJsonReporter()     — one NDJSON line per event (--events).
 *
 * The interactive TUI (phase 2) is a fourth reporter that pushes events into
 * its render state; it lives with the TUI code, not here.
 *
 * ## Methods (the contract)
 *
 * | Method                              | Meaning                                    |
 * |-------------------------------------|--------------------------------------------|
 * | token(text)                         | A streamed assistant/summary text delta.   |
 * | turnEnd({ completed, finalText })   | A model turn finished; completed=true is   |
 * |                                     | the final answer (no more tool calls).     |
 * | toolActivity(name)                  | The model began a tool call (name known    |
 * |                                     | before args finish streaming). TUI-only.   |
 * | toolCall({ name, args })            | A tool call about to run.                   |
 * | toolResult({ name, result })        | A tool call's result (or error).            |
 * | notice(text)                        | A one-line diagnostic/warning.              |
 * | heartbeat({ label, elapsedMs })     | A "still running" tick during a long wait.  |
 * | compaction({ promptTokens, limit }) | Context compaction is starting.             |
 * | verification(result)                | A verification (Stop-hook) outcome.         |
 * | healTurn({ turn, max })             | A heal turn is starting.                    |
 * | summary(result)                     | The end-of-run summary.                     |
 * | phase(name)                         | A run-phase transition (build/verify/heal/  |
 * |                                     | review/memory/compact). No terminal bytes.  |
 */

import {
  formatHealTurn,
  formatHeartbeat,
  formatNotice,
  formatSummary,
  formatToolCall,
  formatToolResult,
  formatVerification,
} from './format.mjs';

/** The full method set — the single source of truth for reporter totality. */
export const REPORTER_METHODS = [
  'token',
  'turnEnd',
  'toolActivity',
  'toolCall',
  'toolResult',
  'notice',
  'heartbeat',
  'compaction',
  'verification',
  'healTurn',
  'summary',
  'phase',
];

/**
 * A reporter whose every method is a no-op. Selected by `--quiet` and `--json`,
 * and the default when a run-path function is called without one.
 * @returns {object}
 */
export function createNullReporter() {
  const reporter = {};
  for (const name of REPORTER_METHODS) {
    reporter[name] = () => {};
  }
  return reporter;
}

/**
 * The terminal reporter — reproduces the harness's historical output exactly:
 * streamed model text to stdout, all other chrome to stderr, each chrome line
 * the matching format.mjs string plus a trailing newline. `phase` and
 * `toolActivity` produce no bytes (they had no terminal representation before).
 * The streams are injectable so tests can assert the produced bytes.
 * @param {{ stdout?: object, stderr?: object }} [streams]
 * @returns {object}
 */
export function createTerminalReporter(streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const line = (text) => stderr.write(`${text}\n`);
  return {
    token: (text) => stdout.write(text),
    turnEnd: ({ completed }) => {
      if (completed) {
        stdout.write('\n');
      }
    },
    toolActivity: () => {},
    toolCall: ({ name, args }) => line(formatToolCall(name, args)),
    toolResult: ({ name, result }) => line(formatToolResult(name, result)),
    notice: (text) => line(formatNotice(text)),
    heartbeat: ({ label, elapsedMs }) =>
      line(formatHeartbeat(label, elapsedMs)),
    compaction: ({ promptTokens, limit }) =>
      line(
        formatNotice(`compacting context (${promptTokens} >= ${limit} tokens)`),
      ),
    verification: (result) => line(formatVerification(result)),
    healTurn: ({ turn, max }) => line(formatHealTurn(turn, max)),
    summary: (result) => line(formatSummary(result)),
    phase: () => {},
  };
}

/**
 * The JSON reporter — one NDJSON object per event on `out` (default stdout),
 * for `--events`. Streamed tokens are coalesced: consecutive token() deltas
 * accumulate and flush as a single { event: "assistant_text", text } line on
 * the next non-token event, since a line per token would be unusable.
 * @param {{ out?: object }} [options]
 * @returns {object}
 */
export function createJsonReporter(options = {}) {
  const out = options.out || process.stdout;
  let pending = '';

  const emit = (event, payload) => {
    out.write(`${JSON.stringify({ event, ...payload })}\n`);
  };
  const flush = () => {
    if (pending) {
      out.write(
        `${JSON.stringify({ event: 'assistant_text', text: pending })}\n`,
      );
      pending = '';
    }
  };
  const event = (name, payload) => {
    flush();
    emit(name, payload || {});
  };

  return {
    token: (text) => {
      pending += text;
    },
    turnEnd: ({ completed }) => event('turn.end', { completed }),
    toolActivity: (name) => event('tool.activity', { name }),
    toolCall: ({ name, args }) => event('tool.call', { name, args }),
    toolResult: ({ name, result }) => event('tool.result', { name, result }),
    notice: (text) => event('notice', { text }),
    heartbeat: ({ label, elapsedMs }) =>
      event('heartbeat', { label, elapsedMs }),
    compaction: ({ promptTokens, limit }) =>
      event('compaction', { promptTokens, limit }),
    verification: (result) => event('verification', { result }),
    healTurn: ({ turn, max }) => event('heal.turn', { turn, max }),
    summary: (result) =>
      event('summary', {
        stoppedReason: result.stoppedReason,
        filesChanged: result.filesChanged,
        usage: result.usage,
      }),
    phase: (name) => event('phase', { name }),
  };
}
