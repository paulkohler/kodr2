---
name: kodr-spec-author
description: Use when writing a new specs/*.yaml file for Kodr (kodr2), or evolving an existing one — including a feature that emerged mid-conversation with no explicit "add a spec" request. Covers the canonical spec shape (name/status/description/inputs/outputs/constraints/tests), when to reach for the optional approach:/deliverables: sections, the repo's constraint-bullet voice, and keeping status honest through the proposed→accepted→implemented→deprecated lifecycle. Trigger on "write a spec for X", "propose a new feature", or any src/ change that doesn't yet have a specs/ file behind it.
model: sonnet
---

# kodr-spec-author

Every feature in Kodr has a YAML spec in `specs/` — `AGENTS.md`: "Write the
spec before the implementation — including a feature that emerges
organically mid-conversation." This is the shape and voice of a good one,
drawn from reading all 41 specs in the repo, not just that one line.

## Canonical shape

These seven keys are near-universal across `specs/*.yaml`:

```yaml
name: <matches the filename -- specs/tool-read-file.yaml -> name: tool-read-file>
status: proposed   # proposed -> accepted -> implemented -> deprecated

description: >
  What this is and why it exists. Prose, not a feature list. Often carries
  the incident or motivating bug inline rather than a separate rationale
  section -- see "Constraint-bullet voice" below for the same pattern.

inputs:
  <name>:
    type: <string|number|boolean|array|object>
    required: true|false
    description: ...

outputs:
  <name>:
    type: ...
    description: ...

constraints:
  - One behavioral rule per bullet. State the rule, then the concrete reason
    inline -- a past bug, a deliberate tradeoff, a provider quirk -- rather
    than a separate "rationale" section.

tests:
  unit:
    - a plain-English description of one thing a unit test proves
  eval:
    - a plain-English description of one thing an eval proves (only for
      behavior that genuinely needs a real model to verify)
```

`inputs`/`outputs` are missing only on process-level specs that aren't a
function's I/O contract (`specs/distribution.yaml`, `specs/loop-scripts.yaml`).
If the spec describes a function, keep them.

## Two optional sections, used sparingly

- **`approach:`** — present in only 4 of 41 specs. Add it when the spec
  replaces something or chooses between designs worth recording (why not the
  alternative). Skip it for a straightforward new feature; the
  `constraints:` bullets already carry enough "why" on their own.
- **`deliverables:`** — also 4/41. A literal checklist of files that should
  exist once the spec is fully implemented (`specs/verdict.yaml` lists
  `src/verdict.mjs`, `test/verdict.test.mjs`, and the refactor site in
  `goal.mjs`). Useful for a spec spanning multiple new files; skip it for a
  one-file tweak.

## Constraint-bullet voice

Match the repo's existing terseness. Compare:

- Weak: "The loop should stop retrying eventually."
- Repo style (`specs/harness.yaml`): "...a small model can ignore [the
  no-repeat instruction] and burn the whole budget re-sending an identical
  broken call (a real run repeated a write_file with no path six times over
  nine minutes). This enforces the contract."

The parenthetical incident is doing the persuasive work — it's what stops a
future editor from "simplifying" the constraint away.

## `tests:` bullets are a coverage checklist, not a transcript

They don't have to match `it(...)` strings verbatim. `specs/tool-read-file.yaml`'s
bullets mirror `test/tool-loop.test.mjs`'s test names almost exactly, while
`specs/hooks.yaml`'s are paraphrased against `test/hooks.test.mjs` and still
count. What matters: every bullet must be traceable to a real, passing test
somewhere. Nothing in the repo checks this automatically (see below) — before
finishing, manually walk each `tests:` bullet and point to the test that
proves it.

## Keep `status:` honest

`status:` is self-reported and nothing audits it against reality.
`npm run check:specs` (advisory by default; `--strict` to fail) only checks
that `status` is one of the four legal values, not that it matches what's
actually implemented — `specs/verdict.yaml` sat on `status: proposed` for
weeks after its implementation and all 16 tests had landed and were passing.
When a change finishes what a spec describes, flip its `status:` in the same
change; don't leave it for someone else to notice.

## Where it lives

`specs/<feature-name>.yaml`, filename matching `name:`. Run
`npm run check:specs` after writing or editing one.
