# Code review

[Everyday usage](usage.md) · [Unattended loops](loop.md)

After the build completes, run a review pass on a _different_ model: a fresh
read-only conversation over the diff, with `read_file`/`list_files`/`search`
so it can check the change against the real files instead of reacting to a
pasted diff. Kodr owns the LM Studio load/unload/verify sequencing for both
models via the `lms` CLI, so you can build on a fast model and review on a
different one.

```bash
kodr "…" --review-model openai/gpt-oss-20b
```

**Pick the reviewer for whether it uses its tools, not for how clever it
is.** See [Choosing a reviewer](#choosing-a-reviewer) below — this matters
more than any flag on this page.

The reviewer ends with `VERDICT: PASS` or `VERDICT: FAIL`. By default that's
advisory — it's printed, saved to the run record, and counted by
`kodr stats`, but it changes nothing. **`--fail-on-review` makes it a gate:**

```bash
kodr "…" --review-model openai/gpt-oss-20b --fail-on-review
```

Now a FAIL exits non-zero, and in [`kodr loop`](loop.md) it blocks the
commit, retries the task with the reviewer's findings, and parks if it never
passes. A review can catch issues a thin test suite misses. Keep tests as the
primary check, and inspect the reviewer's findings.

Two caveats worth internalising before you leave it on:

- **A review FAIL is not a test failure.** The reviewer can't run anything;
  it's a second model's static read. Real signal, weaker than an exit code,
  and now holding the same veto. Keep `--test` as the primary gate.
- **Verdict parsing is fail-closed.** A reply with no parseable verdict line
  reads as FAIL (after one nudge retry). If your reviewer can't reliably
  produce that final line, `kodr stats` will show it as
  `no verdict: <n>%` rather than leaving you guessing why everything fails.

## Keeping both models resident

On one LM Studio, a review costs **two full model loads per attempt** —
`lms unload --all` runs first, and the build model reloads on the next
attempt. Across a checklist that dominates the run. Give the reviewer its own
endpoint and turn the swap off:

```bash
# builder hot on :1234, reviewer hot on :1235 — zero load/unload cycles
kodr loop --test "npm test" \
  --review-model openai/gpt-oss-20b \
  --review-base-url http://localhost:1235/v1 \
  --no-review-swap --fail-on-review
```

If both endpoints are on the same machine, it needs enough memory to keep
both models loaded. Otherwise use model swapping or a remote reviewer.

`--review-provider` moves the reviewer to a different provider entirely (a
cloud reviewer over a local builder, say). Note it does _not_ inherit the
build's base URL — a different provider brings its own default.

## Choosing a reviewer

Check whether the reviewer uses its tools and whether its findings hold up
when you inspect the code. The prompt asks it to investigate, but model
behavior varies.

Measured on one workspace — a module importing a name its dependency doesn't
export, so it throws at import time — with the identical prompt and harness:

| | `phi-4-reasoning-plus` | `gpt-oss-20b` |
| --- | --- | --- |
| Verdict | `PASS` — wrong | `FAIL` — correct |
| Grounded | no (1 tool call) | yes (4 tool calls) |
| Completion tokens | 44,725 | 447 |
| Wall clock | 1,234s | 8s |

The reasoning model spotted a related arithmetic discrepancy, hypothesised a
behaviour for the missing function that would explain it, never opened the
one file that would have settled the question, and passed the change. The
small model made four tool calls and named the broken export in eight
seconds. This is one recorded example, not a general benchmark of either model.

So: **prefer a model that investigates over one that deliberates**, and
verify before you trust a gate with your commits. The check is one number —

```bash
kodr stats     # review attempted: 100%  passed: 66%  grounded: 0%  no verdict: 0%
               #   phi-4-reasoning-plus: 3 reviewed  passed: 66%  grounded: 0%  no verdict: 0%
```

Each reviewer gets its own line under the summary, so you can run the
comparison above on your own workspace: try one reviewer for a week, another
for the next, and read the two rows off `kodr stats` instead of blending them
into a single number. (Runs recorded before Kodr saved the reviewer's name
bucket under `unknown`.)

`grounded: 0%` means no assessed review met the configured tool-call floor.
It is a reason to inspect the reviewer's behavior; tool-call counts alone do
not establish whether its findings are correct. Run a handful of tasks with
advisory reviews and inspect their findings before adding `--fail-on-review`.

Related tuning: `--review-context-window`, `--review-min-tool-calls`,
`--review-max-tool-turns` (see [`specs/review.yaml`](../specs/review.yaml)).
Grounding is advisory: a PASS from a reviewer that opened no files is
recorded and warned about, but doesn't block. `kodr stats`'
`reviewGroundedRate` tells you whether that's costing you anything.
