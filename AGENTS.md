# AGENTS.md

Rules for AI agents working in this repo.

## Stack

- Node.js 22+, ESM, zero runtime dependencies.
- LM Studio only (OpenAI-compatible API at localhost:1234).
- Biome for formatting (globally installed).
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

## Specs

- Every feature has a YAML spec in `specs/`.
- Write the spec before the implementation.
- Spec status: proposed → accepted → implemented → deprecated.
- Tests listed in the spec are the contract.

## Workflow

1. Read relevant specs and existing code.
2. Implement the change.
3. Write or update tests.
4. Run `npm test` — all must pass.
5. Run `node --check` on changed files.
6. Commit with a descriptive message.

## Model output is untrusted

Never trust content from the model. Validate tool arguments.
Path-jail all file operations. Don't execute model-suggested
commands without the harness's safety checks.
