# AGENTS.md

Rules for AI agents working in this repo.

## Stack

- Node.js 22+, ESM, zero runtime dependencies.
- Three providers, all speaking the same OpenAI-compatible chat completions
  contract (see `specs/provider.yaml`): LM Studio (default, localhost:1234,
  no auth), OpenRouter (hosted, `OPENROUTER_API_KEY` required), and Ollama
  (local by default at localhost:11434, or `https://ollama.com/v1` with
  `OLLAMA_API_KEY` for hosted access). `src/model.mjs` is the shared
  HTTP/streaming client; `src/provider-*.mjs` wrap it with each provider's
  defaults/capabilities, selected via `src/provider.mjs`'s factory --
  callers never construct a provider module directly. The standard
  `/v1/models` endpoint doesn't report context-window state; LM Studio's own
  `/api/v0/models` extension does (`state`, `loaded_context_length`,
  `max_context_length`) and is what LM Studio's `contextInfo`/`richModels`
  rely on -- OpenRouter's `/models` reports `context_length` directly
  instead; Ollama's `/v1/models` reports neither, so `contextInfo` always
  degrades to nulls there.
- Biome for formatting as an external developer tool. Prefer a globally or environment-provided `biome` binary; do not add Biome to `dependencies` or `devDependencies`. CI has no lockfile (by design) and doesn't get Biome preinstalled either — CI must install it itself; never assume it's on the runner.
- `node:test` for all tests.
- JSDoc types are checked via a `jsconfig.json` (`checkJs: true`) plus TypeScript's `tsc --noEmit`, the same "external tool, not a dependency" pattern as Biome: `npm install -g typescript` for the `tsc` binary (`npm run check:types`), and `npm install --no-save @types/node` locally so the IDE's JS language service resolves Node globals (`process`, `Buffer`, etc.). Neither goes in `package.json` — `@types/node` lands in the gitignored `node_modules/` and isn't required for tests or the build, only for IDE IntelliSense and the opt-in `check:types` script.

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
