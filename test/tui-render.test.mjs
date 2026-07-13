import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createTuiState,
  pushLine,
  setApproval,
  setPhase,
  setRunning,
} from '../src/tui-state.mjs';
import {
  displayWidth,
  renderFrame,
  renderMarkdown,
  truncateAnsi,
  wrapAnsi,
} from '../src/tui-render.mjs';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const REVERSE = '\x1b[7m';
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';
const CYAN = '\x1b[36m';

describe('displayWidth', () => {
  it('ignores ANSI escape sequences', () => {
    assert.equal(displayWidth(`${RED}abc${RESET}`), 3);
    assert.equal(displayWidth('plain'), 5);
  });
});

describe('wrapAnsi', () => {
  it('wraps on display width without splitting an escape sequence', () => {
    const pieces = wrapAnsi(`${RED}abcdef${RESET}`, 3);
    assert.equal(pieces.length, 2);
    for (const piece of pieces) {
      assert.ok(displayWidth(piece) <= 3);
    }
    // The color escape stays attached; stripping escapes recovers the text.
    assert.equal(pieces.join('').replace(/\x1b\[[0-9;]*m/g, ''), 'abcdef');
    assert.ok(pieces[0].includes(RED));
  });

  it('returns one (possibly empty) line for an empty string', () => {
    assert.deepEqual(wrapAnsi('', 10), ['']);
  });
});

describe('truncateAnsi', () => {
  it('truncates to display columns and resets color', () => {
    const out = truncateAnsi(`${RED}abcdef${RESET}`, 3);
    assert.equal(displayWidth(out), 3);
    assert.ok(out.endsWith(RESET));
  });
});

describe('renderMarkdown', () => {
  it('renders bold, italic, and inline code', () => {
    const bold = renderMarkdown('a **strong** word');
    assert.ok(bold.includes(BOLD) && bold.includes('strong'));
    assert.equal(displayWidth(bold), 'a strong word'.length);

    const italic = renderMarkdown('an *emphatic* word');
    assert.ok(italic.includes(ITALIC) && italic.includes('emphatic'));

    const code = renderMarkdown('run `npm test` now');
    assert.ok(code.includes(CYAN) && code.includes('npm test'));
  });

  it('turns list markers into bullets and headings into bold', () => {
    const bullet = renderMarkdown('- an item');
    assert.ok(bullet.includes('•'));
    assert.ok(bullet.includes('an item'));

    const heading = renderMarkdown('## Section');
    assert.ok(heading.includes(BOLD) && heading.includes('Section'));
  });

  it('leaves snake_case identifiers and prose stars alone', () => {
    assert.equal(
      renderMarkdown('call run_command here'),
      'call run_command here',
    );
    assert.ok(!renderMarkdown('2 * 3 * 4').includes(ITALIC));
  });

  it('renders bold wrapping inline code, like **`bin/`**', () => {
    const out = renderMarkdown('- **`bin/`**: entry points');
    assert.ok(out.includes(BOLD));
    assert.ok(out.includes(CYAN));
    assert.ok(out.includes('bin/'));
    assert.ok(out.includes('•'));
  });
});

describe('renderFrame', () => {
  const size = { rows: 10, cols: 40 };

  it('draws header, scrollback tail, input line, and hint', () => {
    const state = createTuiState({ model: 'gemma' });
    for (let i = 1; i <= 20; i += 1) {
      pushLine(state, `line ${i}`);
    }
    const frame = renderFrame(state, size, 0);
    assert.ok(frame.includes('kodr'), 'header shows kodr');
    assert.ok(frame.includes('gemma'), 'header shows model');
    assert.ok(frame.includes('line 20'), 'shows the newest scrollback line');
    assert.ok(!frame.includes('line 1\x1b'), 'oldest lines scrolled off');
    assert.ok(frame.includes('enter: send'), 'shows the hint line');
  });

  it('shows the reverse-video caret at the input cursor position', () => {
    const state = createTuiState();
    const frame = renderFrame(state, size, 0);
    assert.ok(frame.includes(REVERSE), 'draws a reverse-video caret');
  });

  it('shows the approval prompt when approval mode is active', () => {
    const state = createTuiState();
    setApproval(state, 'npm test');
    const frame = renderFrame(state, size, 0);
    assert.ok(frame.includes('run command:'));
    assert.ok(frame.includes('npm test'));
    assert.ok(frame.includes('y: run'));
  });

  it('turns the hint row into command suggestions while typing a slash', () => {
    const state = createTuiState();
    state.input = '/c';
    state.cursor = 2;
    const frame = renderFrame(state, size, 0);
    assert.ok(frame.includes('/compact'), 'suggests /compact');
    assert.ok(frame.includes('/clear'), 'suggests /clear');
    assert.ok(!frame.includes('enter: send'), 'replaces the static hint');
  });

  it('caps overflowing suggestions with an ellipsis on one row', () => {
    const state = createTuiState();
    state.input = '/';
    state.cursor = 1;
    const frame = renderFrame(state, { rows: 10, cols: 24 }, 0);
    assert.ok(frame.includes('…'), 'overflow is elided');
  });

  it('restores the static hint once the command word is settled', () => {
    const state = createTuiState();
    state.input = '/model gpt';
    state.cursor = state.input.length;
    const frame = renderFrame(state, size, 0);
    assert.ok(frame.includes('enter: send'), 'argument typed -> static hint');
  });

  it('shows the quit confirmation in the hint row when armed', () => {
    const state = createTuiState();
    state.quitPending = true;
    const frame = renderFrame(state, size, 0);
    assert.ok(frame.includes('ctrl-c again'), 'prompts for a second ctrl-c');
    assert.ok(!frame.includes('enter: send'), 'replaces the static hint');
  });

  it('the quit confirmation outranks the command autocomplete', () => {
    const state = createTuiState();
    state.input = '/c';
    state.cursor = 2;
    state.quitPending = true;
    const frame = renderFrame(state, size, 0);
    assert.ok(frame.includes('ctrl-c again'), 'warning wins over suggestions');
    assert.ok(!frame.includes('/compact'), 'suggestions are suppressed');
  });

  it('shows the current phase in the header while running', () => {
    const state = createTuiState();
    setRunning(state, true, 0);
    setPhase(state, 'verify');
    const frame = renderFrame(state, size, 5000);
    assert.ok(frame.includes('verify'), 'header reflects the phase');
    assert.ok(frame.includes('5s'), 'header shows elapsed seconds');
  });
});
