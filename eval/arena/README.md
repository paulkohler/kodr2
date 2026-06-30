# Harness arena

A benchmark that holds the **model fixed** and varies the **harness**, to
measure what Kodr's features actually contribute. Most leaderboards do the
opposite (fix the harness, rank models); this is the transpose, in the spirit of
Harness-Bench and Claw-SWE-Bench.

It runs each task through Kodr under several feature ablations and reports
**pass@k _and_ cost** (turns, tokens, heals, aborts) — because at a fixed model
the harness drives efficiency far more than raw pass-rate.

## Run it

```bash
npm run arena                                  # full matrix
npm run arena -- --variant heal --repeats 1    # one quick cell
npm run arena -- --task todo-rust-lib
```

Needs a model loaded in LM Studio (or any OpenAI-compatible server at the
`baseUrl` in `variants.json`). If the server is unreachable the run skips
cleanly. It is **not** part of `npm test` — it needs a real model and takes
minutes (each cell is a fresh workspace + a full Kodr run + the task verifier).

## Layout

```
eval/arena/
  variants.json          fixed model + the ablation matrix
  tasks/*.task.json       harness-agnostic tasks: prompt, setup, verify, budget
  run.mjs                 runner: fresh workspace -> Kodr -> verify -> job record
  report.mjs              pure aggregation -> markdown (unit-tested in test/)
  jobs/<timestamp>/       output: jobs.json, report.md, per-run kodr records
```

## How a cell runs

For each `task × variant × repeat`:

1. Make a fresh temp workspace and run the task's `setup`.
2. Run Kodr headless with the variant's knobs (`--test` gate on/off,
   `--heal-turns`, env like `KODR_HEAL_RESERVE`), writing its run record to
   `--runs-dir` (outside the workspace, via change #1).
3. Run the task's `verify` in the workspace — this is the **ground truth**,
   independent of any in-harness gate.
4. Record `{ passed, toolTurns, tokens, healed, stoppedReason }`.

## Variants (`variants.json`)

| variant | gate (`--test`) | heal turns | notes |
|---|---|---|---|
| baseline | off | 0 | no gate, no repair |
| gate | on | 0 | verify, but no heal |
| heal | on | 3 | gate + heal loop |
| heal-no-reserve | on | 3 | `KODR_HEAL_RESERVE=0` |

The matrix is intentionally limited to knobs Kodr exposes today. Finer
ablations — e.g. tool-call recovery on/off — need feature flags that don't exist
yet; add them as Kodr grows, and the matrix grows with them.

## Tasks (`*.task.json`)

```json
{
  "name": "todo-rust-lib",
  "prompt": "Create a Rust library crate ...",
  "setup": "",
  "verify": "cargo test --quiet",
  "budgetMs": 300000,
  "repeats": 3
}
```

The schema is harness-agnostic on purpose: the same task files could later drive
a Terminal-Bench-style cross-harness run (Kodr vs other harnesses at the same
model) without change.
