/**
 * TUI frame rendering — pure. Given render state and terminal dimensions,
 * build the ANSI string for one full-screen frame. No I/O, so every layout
 * decision is unit-testable without a real terminal.
 *
 * The frame is a full redraw: each row is positioned and cleared, so a taller
 * previous frame never leaves stale rows behind. Streamed tokens land only in
 * the scrollback region because the input line is always drawn last.
 */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NOBOLD = '\x1b[22m';
const ITALIC = '\x1b[3m';
const NOITALIC = '\x1b[23m';
const REVERSE = '\x1b[7m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DEFAULT_FG = '\x1b[39m';

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR (color) escapes requires the ESC control char
const ANSI = /\x1b\[[0-9;]*m/;
const ANSI_GLOBAL = new RegExp(ANSI.source, 'g');

/** Display width of a string, ignoring ANSI color escapes. */
export function displayWidth(str) {
  return str.replace(ANSI_GLOBAL, '').length;
}

/**
 * Wrap a line to `width` display columns, treating ANSI escapes as zero width
 * and never splitting one across a break. Returns at least one line (possibly
 * empty), so an empty logical line still occupies a row.
 * @returns {string[]}
 */
export function wrapAnsi(line, width) {
  if (width <= 0) {
    return [line];
  }
  const out = [];
  let cur = '';
  let col = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const match = ANSI.exec(line.slice(i));
      if (match && match.index === 0) {
        cur += match[0];
        i += match[0].length;
        continue;
      }
    }
    cur += line[i];
    col += 1;
    i += 1;
    if (col === width) {
      out.push(cur);
      cur = '';
      col = 0;
    }
  }
  // Drop a trailing piece that is only escapes (zero display width) so it
  // doesn't render as a spurious blank line; always keep at least one line.
  if ((cur !== '' && displayWidth(cur) > 0) || out.length === 0) {
    out.push(cur);
  }
  return out;
}

/** Truncate a string to `width` display columns, keeping escapes intact. */
export function truncateAnsi(str, width) {
  if (displayWidth(str) <= width) {
    return str;
  }
  let out = '';
  let col = 0;
  let i = 0;
  while (i < str.length && col < width) {
    if (str[i] === '\x1b') {
      const match = ANSI.exec(str.slice(i));
      if (match && match.index === 0) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += str[i];
    col += 1;
    i += 1;
  }
  return out + RESET;
}

/**
 * Render one line of simple inline Markdown to ANSI: **bold**, *italic* /
 * _italic_, `code`, `- `/`* ` bullets, and `#` headings. Applied to streamed
 * assistant text as it enters scrollback; chrome lines are already ANSI and
 * are not passed through here. Deliberately line-scoped and best-effort -- no
 * block parsing, no nesting beyond a single span.
 * @param {string} line
 * @returns {string}
 */
export function renderMarkdown(line) {
  const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    return `${BOLD}${inlineMarkdown(heading[2])}${NOBOLD}`;
  }
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (bullet) {
    return `${bullet[1]}${DIM}•${RESET} ${inlineMarkdown(bullet[2])}`;
  }
  return inlineMarkdown(line);
}

// Inline spans only. Code is substituted first so its contents aren't treated
// as emphasis; bold (**) before italic (*) so a double star isn't read as two
// empty italics. Italic requires non-space just inside the markers, and the
// underscore form requires word boundaries, so prose stars and identifiers
// like run_command are left alone.
function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, `${CYAN}$1${DEFAULT_FG}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${NOBOLD}`)
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, `${ITALIC}$1${NOITALIC}`)
    .replace(/(^|\W)_(\S(?:[^_\n]*\S)?)_(?=\W|$)/g, `$1${ITALIC}$2${NOITALIC}`);
}

/**
 * Build one full-screen frame.
 * @param {object} state - TUI state (see tui-state.mjs)
 * @param {{ rows: number, cols: number }} size
 * @param {number} [now] - Current epoch ms, for the elapsed clock (injectable)
 * @returns {string}
 */
export function renderFrame(state, size, now = Date.now()) {
  const rows = Math.max(size.rows || 0, 4);
  const cols = Math.max(size.cols || 0, 8);

  const lines = new Array(rows).fill('');
  lines[0] = truncateAnsi(headerLine(state, now), cols);

  const sepRow = rows - 3;
  const inputRow = rows - 2;
  const hintRow = rows - 1;
  const scrollHeight = Math.max(sepRow - 1, 1);

  const visible = scrollbackWindow(state, cols, scrollHeight);
  const pad = scrollHeight - visible.length;
  for (let r = 0; r < scrollHeight; r += 1) {
    lines[1 + r] = r < pad ? '' : visible[r - pad];
  }

  lines[sepRow] = `${DIM}${'─'.repeat(cols)}${RESET}`;
  lines[inputRow] = truncateAnsi(inputLine(state), cols);
  lines[hintRow] = truncateAnsi(hintLine(state), cols);

  // A trailing RESET per row stops an unclosed color (e.g. a wrapped colored
  // line) from bleeding into the next row.
  let frame = '\x1b[?25l';
  for (let r = 0; r < rows; r += 1) {
    frame += `\x1b[${r + 1};1H\x1b[2K${lines[r]}${RESET}`;
  }
  return frame;
}

function headerLine(state, now) {
  const phase =
    state.running && state.phase
      ? `${CYAN}▸ ${state.phase}${RESET}`
      : state.status;
  const queued = state.queued ? `${DIM} (queued)${RESET}` : '';
  const tokens = `${DIM}${state.tokensIn} in / ${state.tokensOut} out${RESET}`;
  const cost = state.cost ? `  ${DIM}$${state.cost.toFixed(4)}${RESET}` : '';
  const elapsed =
    state.running && state.runStartedAt !== null
      ? `  ${DIM}${Math.round((now - state.runStartedAt) / 1000)}s${RESET}`
      : '';
  return `${BOLD}kodr${RESET} ${DIM}${state.model}${RESET}  ${phase}${queued}  ${tokens}${cost}${elapsed}`;
}

/** The last `height` wrapped display lines of scrollback plus any live stream. */
function scrollbackWindow(state, cols, height) {
  const logical = state.scrollback.slice();
  if (state.stream) {
    for (const line of state.stream.split('\n')) {
      logical.push(line);
    }
  }
  const wrapped = [];
  for (const line of logical) {
    for (const piece of wrapAnsi(line, cols)) {
      wrapped.push(piece);
    }
  }
  return wrapped.slice(Math.max(0, wrapped.length - height));
}

function inputLine(state) {
  if (state.approval) {
    return `${YELLOW}run command:${RESET} ${state.approval.command}  ${DIM}[y/N]${RESET}`;
  }
  const before = state.input.slice(0, state.cursor);
  const at = state.input[state.cursor] ?? ' ';
  const after = state.input.slice(state.cursor + 1);
  return `${CYAN}›${RESET} ${before}${REVERSE}${at}${RESET}${after}`;
}

function hintLine(state) {
  if (state.approval) {
    return `${DIM}y: run · n: skip${RESET}`;
  }
  return `${DIM}enter: send · ctrl-c: quit${RESET}`;
}
