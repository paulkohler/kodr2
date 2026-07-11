/**
 * The TUI reporter — the fourth reporter (see specs/reporter.yaml). Each
 * reporter method mutates the shared TUI render state and asks for a redraw.
 * Tool/notice/verify/heal/summary lines reuse the same format.mjs strings the
 * terminal reporter uses, so the TUI reads like the CLI, just inside a frame.
 */

import {
  formatHealTurn,
  formatNotice,
  formatSummary,
  formatToolCall,
  formatToolResult,
  formatVerification,
} from './format.mjs';
import { renderMarkdown } from './tui-render.mjs';
import {
  addToken,
  applyUsage,
  flushStream,
  noteOnce,
  pushLine,
  setPhase,
  setStatus,
} from './tui-state.mjs';

/**
 * @param {import('./tui-state.mjs').TuiState} state - TUI state (mutated)
 * @param {() => void} requestRender - Schedule a (throttled) redraw
 * @returns {import('./reporter.mjs').Reporter}
 */
export function createTuiReporter(state, requestRender) {
  const render = requestRender || (() => {});
  // Buffered like the JSON reporter (src/reporter.mjs): streamed tokens
  // accumulate in state.stream, and any non-token event first flushes them
  // into scrollback so the streamed text is ordered ahead of the discrete
  // line it preceded (e.g. an assistant preamble emitted alongside a
  // tool_call). Assistant text is rendered from Markdown to ANSI as it flushes;
  // flush is a no-op when nothing is buffered.
  const flush = () => flushStream(state, renderMarkdown);
  const line = (text) => {
    flush();
    pushLine(state, text);
    render();
  };
  return {
    token: (text) => {
      addToken(state, text);
      render();
    },
    turnEnd: () => {
      flush();
      render();
    },
    // The model started a call before its args finished streaming; the
    // toolCall line lands a moment later, so nothing to show yet.
    toolActivity: () => {},
    toolCall: ({ name, args }) => line(formatToolCall(name, args)),
    toolResult: ({ name, result }) => line(formatToolResult(name, result)),
    // Shown once per session -- a note repeated on a later turn (e.g. the
    // context-window notice emitted at the start of every run) isn't reprinted.
    notice: (text) => {
      if (noteOnce(state, text)) {
        line(formatNotice(text));
      }
    },
    // Heartbeats repeat during a single wait, so they update the status word
    // rather than spamming scrollback (the header already shows elapsed time).
    // Kept on a bare render so a mid-wait tick isn't a stream flush point.
    heartbeat: ({ label }) => {
      setStatus(state, `${label}…`);
      render();
    },
    compaction: ({ promptTokens, limit }) => {
      setPhase(state, 'compact');
      line(
        formatNotice(`compacting context (${promptTokens} >= ${limit} tokens)`),
      );
    },
    verification: (result) => line(formatVerification(result)),
    healTurn: ({ turn, max }) => line(formatHealTurn(turn, max)),
    summary: (result) => {
      line(formatSummary(result));
      applyUsage(state, result.usage);
    },
    phase: (name) => {
      flush();
      setPhase(state, name);
      render();
    },
  };
}
