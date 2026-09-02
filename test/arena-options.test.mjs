import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  parseArgs,
  recordDirFor,
  selectModel,
} from '../eval/arena/options.mjs';

describe('arena options', () => {
  it('accepts an optional --model override', () => {
    const opts = parseArgs([
      '--model',
      'google/gemma-4-26b-a4b',
      '--task',
      'todo-rust-lib',
    ]);

    assert.equal(opts.model, 'google/gemma-4-26b-a4b');
    assert.equal(opts.task, 'todo-rust-lib');
  });

  it('falls back to variants.json when --model is absent', () => {
    const config = { model: 'mistralai/devstral-small-2-2512' };

    assert.equal(selectModel(config, parseArgs([])), config.model);
  });

  it('prefers --model over variants.json', () => {
    const config = { model: 'mistralai/devstral-small-2-2512' };
    const opts = parseArgs(['--model', 'qwen3.8-27b-mlx']);

    assert.equal(selectModel(config, opts), 'qwen3.8-27b-mlx');
  });

  it('resolves cell records outside the temporary workspace', () => {
    const recordDir = recordDirFor(
      'eval/arena/jobs/gemma',
      'heal-no-reserve',
      0,
    );

    assert.equal(
      recordDir,
      resolve('eval/arena/jobs/gemma', 'records', 'heal-no-reserve-0'),
    );
  });
});
