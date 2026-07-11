# Contributing

Kodr requires Node.js 22 or newer and LM Studio for live evals.

1. Read `AGENTS.md` and the relevant YAML specs.
2. Update the spec before changing behavior.
3. Add deterministic tests under `test/`.
4. Run `npm test`, `npm run check`, and `npm run format:check`.
5. Run `npm run eval` when LM Studio is available.

For IDE type support (hover types, JSDoc IntelliSense) and `npm run
check:types`, install `@types/node` and `typescript` yourself -- kept out of
`package.json` by the zero-dependency guard, same as Biome:

```bash
npm install --no-save @types/node   # Node globals for the editor's JS language service
npm install -g typescript           # tsc binary for `npm run check:types`
```

Keep pull requests focused. Explain the user-visible behavior, safety impact, and
verification performed. Do not commit model files, credentials, local settings,
or `.kodr/` transcripts.
