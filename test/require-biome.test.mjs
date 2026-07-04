import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBiomeAvailable } from '../scripts/require-biome.mjs';

describe('isBiomeAvailable', () => {
  it('returns true when the probe succeeds', () => {
    assert.equal(
      isBiomeAvailable(() => {}),
      true,
    );
  });

  it('returns false when the probe throws (binary missing)', () => {
    assert.equal(
      isBiomeAvailable(() => {
        throw new Error('ENOENT');
      }),
      false,
    );
  });
});
