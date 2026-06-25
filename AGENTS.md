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

## Testing

- Unit tests in `test/`. Fast, deterministic, no network.
- Evals in `eval/`. Hit real LM Studio. Slow, non-deterministic.
- No model mocks. Tests either need the model (eval) or don't (unit).
- Run tests: `npm test` (`node --test test/*.test.mjs`)
- Run evals: `npm run eval` (`node --test eval/*.eval.mjs`)

## Specs

- Every feature or behavior change MUST have a YAML spec in `specs/`. No spec, no code.
- Write or update the spec FIRST and get it to `accepted` before writing any implementation.
- The spec is the contract: implement to satisfy it, and keep it in sync when behavior changes.
- Spec status: proposed → accepted → implemented → deprecated.
- Tests listed in the spec are the contract. Flip the status to `implemented` only once they pass.

## Workflow

1. Write or update the YAML spec in `specs/` first (status `accepted`). No code without a spec.
2. Read the spec and existing code.
3. Implement the change to satisfy the spec.
4. Write or update tests (the spec's `tests` list is the contract).
5. Run `npm test` — all must pass.
6. Run `node --check` on changed files.
7. Flip the spec status to `implemented`.
8. Commit with a descriptive message.

## Model output is untrusted

Never trust content from the model. Validate tool arguments.
Path-jail all file operations. Don't execute model-suggested
commands without the harness's safety checks.
