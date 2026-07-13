/**
 * The ACP reporter — the fifth reporter (see specs/reporter.yaml and
 * specs/acp.yaml). Each mapped method turns a run event into an ACP
 * `session/update` payload and hands it to the injected `send`. The rest are
 * no-ops: the reporter stays total (every REPORTER_METHODS name exists) but
 * only the subset with a faithful ACP representation produces output, exactly
 * as the null reporter is total-but-silent.
 *
 * This is the ACP analogue of the TUI reporter (src/tui-reporter.mjs): where
 * that one mutates render state and asks for a redraw, this one serializes a
 * session/update variant. Same seam, different sink.
 */

import { REPORTER_METHODS } from './reporter.mjs';
import { toolKindFor } from './acp-protocol.mjs';

/**
 * @param {(update: object) => void} send - Emit one ACP SessionUpdate payload
 *   (the `update` field of a session/update notification).
 * @param {{ toolCallId: string|null }} [turnState] - Shared per-turn state so
 *   the confirm channel can reference the tool_call currently streaming. The
 *   latest tool call's id is written here as toolCall fires.
 * @returns {import('./reporter.mjs').Reporter}
 */
export function createAcpReporter(send, turnState = { toolCallId: null }) {
  const reporter = /** @type {import('./reporter.mjs').Reporter} */ ({});
  for (const name of REPORTER_METHODS) {
    reporter[name] = () => {};
  }

  let toolCallCount = 0;
  const planPhases = [];

  reporter.token = (text) => {
    if (!text) {
      return;
    }
    send({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  };

  reporter.toolCall = ({ name, args }) => {
    toolCallCount++;
    const toolCallId = `call_${toolCallCount}`;
    turnState.toolCallId = toolCallId;
    send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: name,
      kind: toolKindFor(name),
      status: 'pending',
      rawInput: args,
    });
  };

  reporter.toolResult = ({ result }) => {
    if (!turnState.toolCallId) {
      return;
    }
    send({
      sessionUpdate: 'tool_call_update',
      toolCallId: turnState.toolCallId,
      status: result && result.error ? 'failed' : 'completed',
      rawOutput: result,
    });
  };

  reporter.phase = (name) => {
    planPhases.push(name);
    send({
      sessionUpdate: 'plan',
      entries: planEntries(planPhases),
    });
  };

  return reporter;
}

/**
 * Build the plan entries for the phases seen so far: the last is in_progress,
 * every earlier one completed.
 * @param {string[]} phases
 * @returns {Array<{ content: string, priority: string, status: string }>}
 */
function planEntries(phases) {
  return phases.map((phase, index) => ({
    content: phase,
    priority: 'medium',
    status: index === phases.length - 1 ? 'in_progress' : 'completed',
  }));
}
