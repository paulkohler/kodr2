# AGENTS.md

Rules for AI agents working in this repo.

## Stack

- Node.js 22+, ESM, zero runtime dependencies.
- LM Studio only (OpenAI-compatible API at localhost:1234). The standard
  `/v1/models` endpoint doesn't report context-window state; LM Studio's own
  `/api/v0/models` extension does (`state`, `loaded_context_length`,
  `max_context_length`) and is what `contextInfo`/`richModels` in
  `src/model.mjs` rely on.
- Biome for formatting as an external developer tool. Prefer a globally or environment-provided `biome` binary; do not add Biome to `dependencies` or `devDependencies`. CI has no lockfile (by design) and doesn't get Biome preinstalled either — CI must install it itself; never assume it's on the runner.
- `node:test` for all tests.

## Code style

- No TypeScript. JSDoc where types help readability.
- No classes unless instance state is genuinely needed.
- Functions return plain objects, not class instances.
- Errors at module boundaries are returned values `{ error: 'msg' }`, not thrown.
- No ternaries in branch logic. Use if/else.
- No tri-state booleans. No `'auto'` mode. Boolean flags only.
- No async/await deeper than 3 levels. Extract a function.
- File names are kebab-case: `read-file.mjs`.
- Keep functions short. If it scrolls, split it.
- Timeouts and resource limits must be configurable or overridable. Defaults are fine, but do not hide fixed delays, retry counts, model request limits, command timeouts, output limits, or similar operational limits in code that callers cannot change.

## Testing

- Unit tests in `test/`. Fast, deterministic, no network.
- Evals in `eval/`. Hit real LM Studio. Slow, non-deterministic.
- No model mocks. Tests either need the model (eval) or don't (unit).
- Run tests: `npm test` (`node --test test/*.test.mjs`)
- Run evals: `npm run eval` (`node --test eval/*.eval.mjs`)
- `npm test`, `npm pack`, and `npm publish` run the zero-dependency guard. `package.json` must not contain entries in `dependencies` or `devDependencies`.

## Specs

- Every feature has a YAML spec in `specs/`.
- Write the spec before the implementation — including a feature that emerges
  organically mid-conversation, not only one explicitly requested as "add
  this to specs."
- Spec status: proposed → accepted → implemented → deprecated.
- Tests listed in the spec are the contract.

## Workflow

1. Read relevant specs and existing code.
2. Implement the change.
3. Write or update tests.
4. Run `npm test` — all must pass.
5. Run `node --check` on changed files.
6. Commit with a descriptive message.
7. Split unrelated changes into separate, well-commented commits, even when made in one session.

## Gotchas

- Read a file before Edit/Write in the *same turn*, even if you edited it
  earlier in the session — and re-Read it after running an external
  formatter (`biome format --write` / `lint --write`) against it, since that
  changes the file on disk out from under a stale read.
- Don't chain `sleep N && <check output>` to poll a long-running or
  backgrounded command. Use the harness/tooling's own background-run and
  notification support instead.

## Model output is untrusted

Never trust content from the model. Validate tool arguments.
Path-jail all file operations. Don't execute model-suggested
commands without the harness's safety checks.
