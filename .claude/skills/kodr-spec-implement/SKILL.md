---
name: kodr-spec-implement
description: Use when implementing or changing behavior in Kodr (kodr2) that has a spec in specs/, or when a code change needs its spec brought back into sync. Covers reading every spec that touches the change (not just the obvious one), hunting the whole repo for stale prose describing the old behavior, syncing constraints/tests bullets, running the full suite rather than the touched file, and flipping status when work lands. Trigger on "implement <spec>", "update the read_file tool", "add a hook", or any src/ change that has a specs/*.yaml file behind it.
model: sonnet
---

# kodr-spec-implement

Kodr specs (`specs/*.yaml`) are the contract, not documentation of one living
in code — `AGENTS.md`: "Tests listed in the spec are the contract." This is
the checklist for going from "here's what should change" to "spec, code, and
tests all agree," covering the ways that quietly fails even when the code
change itself is correct.

## Steps

1. **Read every spec that touches the change, not just the obvious one.** A
   feature's contract can be duplicated across files — `specs/tool-read-file.yaml`
   documents `read_file`'s model-facing serialization, and
   `specs/harness.yaml`'s own `tests:` block repeats the same bullets
   independently, because the tool loop that does the serializing lives in
   `harness.mjs`'s call graph. Grep `specs/*.yaml` for the tool/feature/constant
   name before starting, not after.

2. **Grep the whole repo for the fact you're about to change**, not just
   `specs/`. A number or behavior gets copied into prose in more places than
   expected: `README.md`, `docs/*.md`, `--help` text in `src/cli.mjs`, JSDoc
   comments, other specs. Bumping `MAX_TOOL_TURNS` from 20 to 50 touched five
   separate doc locations plus a hard-failing unit test asserting the old
   default — none of them were the file that actually changed.

   ```
   grep -rn "<old value or behavior>" --include="*.mjs" --include="*.yaml" --include="*.md" .
   ```

3. **Update the spec's `constraints:` and `tests:` bullets in the same pass
   as the code**, not as an afterthought. New behavior needs a new
   constraint bullet; a new test needs a matching `tests: unit:` (or
   `eval:`) bullet. See the `kodr-spec-author` skill for how these should
   read.

4. **Implement per `AGENTS.md`'s code style** — no ternaries in branch
   logic, no classes unless instance state is genuinely needed, configurable
   timeouts/limits (never a hardcoded number a caller can't override),
   kebab-case filenames, functions short enough not to scroll.

5. **Write or update tests colocated with the behavior**
   (`test/<module>.test.mjs`). No model mocks — if it needs a model, it's an
   eval in `eval/`, not a unit test.

6. **Run the full suite, not just the file you touched: `npm test`.** A
   change can break assertions in a file with no visible import relationship
   to the diff — a tool-loop default change broke a CLI-args default check
   in a completely different test file.

7. **Run `npm run check:specs`** (add `--strict` to treat it as a hard gate)
   and `node --check` on every changed `.mjs` file. `check:specs` only
   validates schema shape — `name`/`status`/`description` present, `status`
   a legal value — it will not catch a stale `status`, a missing test
   bullet, or drifted prose. That verification is manual; do it before
   calling the work done.

8. **Flip the spec's `status:`** if this change takes it from
   `proposed`/`accepted` to something a passing test suite now backs — don't
   leave it stale. `specs/verdict.yaml` sat on `status: proposed` for weeks
   after `src/verdict.mjs` and its 16 tests were fully implemented and
   passing; nothing flagged it.

9. **Don't fold an incidental fix into the main change's commit.** Per
   `AGENTS.md`, split unrelated changes into separate commits even when made
   in one sitting — leave everything staged/unstaged as-is for the user to
   split, unless told otherwise.

## What "done" looks like

- `npm test` passes in full, not just the file under change.
- Every spec bullet touched by the change is still true of the code.
- No stale prose describing the old behavior survives anywhere in the repo.
- The spec's `status:` reflects what's actually implemented and tested.
