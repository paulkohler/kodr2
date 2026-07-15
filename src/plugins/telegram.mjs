/**
 * Telegram plugin — mirrors a run's turns to a Telegram channel.
 *
 * A plugin is an output sink: it observes the run through the reporter channel
 * (specs/reporter.yaml) and posts a plain-text copy of each turn to Telegram.
 * The model never sees it and it feeds nothing back into the conversation.
 * Credentials come from the environment, never config or the repo, and egress
 * is opt-in — the plugin only runs when it is explicitly enabled.
 *
 * setup() returns a Reporter (built on the null reporter for totality, with
 * only the methods it cares about overridden), or { error } to disable itself
 * when credentials are missing. The harness fans the run reporter out to it.
 */

import { createNullReporter } from '../reporter.mjs';

const TELEGRAM_LIMIT = 4096;

const plugin = {
  name: 'telegram',

  /**
   * Build the Telegram reporter, or return { error } to disable the plugin.
   * @param {object} config - Plugin config; may carry an injected transport
   * @param {object} ctx - Host context (cwd, env)
   * @returns {import('../reporter.mjs').Reporter | { error: string }}
   */
  setup(config = {}, ctx = {}) {
    const env = ctx.env ?? process.env;
    const token = env.KODR_TELEGRAM_TOKEN;
    const chatId = env.KODR_TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return {
        error:
          'telegram plugin disabled: set KODR_TELEGRAM_TOKEN and KODR_TELEGRAM_CHAT_ID',
      };
    }

    const transport = config.transport ?? fetchTransport(token, chatId);
    const send = serialize(transport);
    return telegramReporter(send);
  },
};

export default plugin;

/**
 * Build a reporter that mirrors turns, tool calls, and the summary to `send`.
 * Streamed token deltas are accumulated and flushed as one message per turn,
 * so the channel gets whole turns rather than a message per token.
 * @param {(text: string) => Promise<void>} send
 * @returns {import('../reporter.mjs').Reporter}
 */
export function telegramReporter(send) {
  const reporter = createNullReporter();
  let buffer = '';

  reporter.token = (text) => {
    buffer += text;
  };
  reporter.turnEnd = () => {
    const turn = buffer;
    buffer = '';
    const text = renderTurn(turn);
    if (text) {
      return send(text);
    }
  };
  reporter.toolCall = ({ name, args }) => send(renderToolCall({ name, args }));
  reporter.summary = (result) => send(renderSummary(result));

  return reporter;
}

/**
 * Serialize sends through a single tail promise so channel messages keep run
 * order even though the reporter is fire-and-forget. A rejected send is
 * swallowed so the tail never breaks.
 * @param {(text: string) => Promise<unknown>} transport
 * @returns {(text: string) => Promise<void>}
 */
export function serialize(transport) {
  let tail = Promise.resolve();
  return (text) => {
    tail = tail.then(() => transport(truncate(text))).catch(() => {});
    return tail;
  };
}

/**
 * Default transport: POST a plain-text message to the Telegram Bot API.
 * Plain text (no parse_mode) means untrusted model output is never rendered
 * as markup.
 * @param {string} token
 * @param {string} chatId
 * @returns {(text: string) => Promise<void>}
 */
function fetchTransport(token, chatId) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return async (text) => {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  };
}

/**
 * Render an assistant turn's accumulated text. Returns '' for an empty turn
 * (e.g. a turn that only made tool calls, whose text is empty) so nothing is
 * sent.
 * @param {string} text
 * @returns {string}
 */
export function renderTurn(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return '';
  }
  return `💬 ${trimmed}`;
}

/**
 * Render a tool call: its name and a short argument summary.
 * @param {{ name: string, args: object }} call
 * @returns {string}
 */
export function renderToolCall(call) {
  const summary = JSON.stringify(call.args ?? {});
  return `🔧 ${call.name} ${summary}`;
}

/**
 * Render a compact run summary from the final result.
 * @param {object} result
 * @returns {string}
 */
export function renderSummary(result = {}) {
  const lines = ['✅ run complete'];
  const files = result.filesChanged ?? [];
  if (files.length > 0) {
    lines.push(`files: ${files.join(', ')}`);
  }
  if (result.verification) {
    lines.push(`verify: ${result.verification.passed ? 'pass' : 'fail'}`);
  }
  if (result.usage) {
    lines.push(
      `tokens: ${result.usage.prompt} in / ${result.usage.completion} out`,
    );
  }
  return lines.join('\n');
}

/**
 * Cap a message at Telegram's 4096-character limit.
 * @param {string} text
 * @returns {string}
 */
export function truncate(text) {
  const value = String(text ?? '');
  if (value.length <= TELEGRAM_LIMIT) {
    return value;
  }
  const marker = '\n… (truncated)';
  return value.slice(0, TELEGRAM_LIMIT - marker.length) + marker;
}
