import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lintSpec } from '../scripts/check-specs.mjs';

function spec(constraints) {
  return `name: example
status: implemented
description: >
  Example spec.
constraints:
${constraints}
`;
}

describe('spec sequence formatting', () => {
  it('accepts one-line, block, mapped, and fully quoted items', () => {
    const text = spec(`  - one line
  - >
    folded line one
    folded line two
  - |
    literal line
  - name: example
    description: mapped item
  - "quoted: value"`);

    assert.deepEqual(lintSpec('example.yaml', text), []);
  });

  it('warns on an implicitly wrapped sequence string', () => {
    const text = spec(`  - wrapped line one
    wrapped line two`);

    assert.deepEqual(lintSpec('example.yaml', text), [
      'example.yaml:6: sequence prose must use an explicit block scalar',
    ]);
  });

  it('warns on unsafe plain sequence strings', () => {
    const text = spec(`  - label: prose, not a mapping
  - "partial quote" followed by prose
  - \`command\` starts with a backtick`);

    assert.deepEqual(lintSpec('example.yaml', text), [
      'example.yaml:6: sequence prose must use an explicit block scalar',
      'example.yaml:7: sequence prose must use an explicit block scalar',
      'example.yaml:8: sequence prose must use an explicit block scalar',
    ]);
  });

  it('ignores list-like text inside an existing block scalar', () => {
    const text = `name: example
status: implemented
description: >
  Embedded example:
    - label: prose
constraints:
  - safe
`;

    assert.deepEqual(lintSpec('example.yaml', text), []);
  });
});
