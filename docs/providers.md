# Providers

[Everyday usage](usage.md) · [Run management](runs.md)

Choose a provider, start or configure it, then run `kodr doctor` with the same
provider and model options you intend to use for your task.

## LM Studio

Load a tool-capable model and start LM Studio's API server on port 1234.
Kodr uses this provider by default and auto-detects the loaded model:

```bash
kodr doctor
kodr models
kodr "fix the failing test" --test "npm test"
```

## Ollama

Start Ollama and make a tool-capable model available. Select its installed
model ID explicitly, or omit `--model` to use the first listed model:

```bash
kodr doctor --provider ollama --model qwen3-coder:30b
kodr "fix the failing test" --provider ollama --model qwen3-coder:30b
```

For direct hosted access, set `OLLAMA_API_KEY`, use
`--base-url https://ollama.com/v1`, and select a model available to your account.

## OpenRouter

Set `OPENROUTER_API_KEY` in your shell and choose an available model ID:

```bash
export OPENROUTER_API_KEY=your-api-key
kodr doctor --provider openrouter --model your-model-id
kodr "fix the failing test" --provider openrouter --model your-model-id
```

Replace the placeholders with your credentials and model choice. Hosted runs
send workspace context and tool results to the configured provider.

## Defaults and capabilities

|                            | `lmstudio` (default)                               | `openrouter`                        | `ollama`                                      |
| -------------------------- | -------------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| Default base URL           | `http://localhost:1234/v1`                         | `https://openrouter.ai/api/v1`      | `http://localhost:11434/v1`                   |
| Auth                       | none                                               | `OPENROUTER_API_KEY` (required)     | `OLLAMA_API_KEY` (optional)                   |
| `--model`                  | optional, auto-detects the loaded model            | **required**                        | optional, auto-detects the first listed model |
| Model load/unload          | explicit, via the `lms` CLI (see `--review-model`) | n/a — model is just a request field | n/a — Ollama manages this itself              |
| Context-window auto-detect | yes                                                | yes                                 | no (falls back to the default)                |
| `--reasoning`              | not supported                                      | supported                           | not supported                                 |
| Per-request cost           | always $0 (local)                                  | real, reported by OpenRouter        | always $0                                     |

The cost row describes what Kodr records. A zero figure for Ollama means
the API does not report per-request cost to Kodr; it is not a statement about
hosted-service pricing.

Set persistent defaults in your shell:

```bash
export KODR_PROVIDER=openrouter
export KODR_MODEL=your-model-id
kodr "fix the failing test"
```

Explicit `--provider` and `--model` options take precedence over those variables.
Use `--base-url` for a different compatible endpoint.

## Context windows

Kodr can detect context length from LM Studio and OpenRouter. Ollama's
OpenAI-compatible model listing does not provide that information to Kodr,
so Kodr falls back to 8192 tokens for compaction bookkeeping. If the server's
model is configured with a larger window, set Kodr to match:

```bash
kodr "…" --provider ollama --context-window 32768
```

This flag changes Kodr's bookkeeping; it does not resize the server's context
window. See [Compaction](runs.md#context-and-compaction).

## Reasoning

`--reasoning` (or `KODR_REASONING`) requests reasoning tokens through Kodr's
OpenRouter provider. Kodr rejects this flag with its LM Studio and Ollama
providers. This is a Kodr provider capability, not a statement about whether
the underlying model can reason.

## OpenRouter privacy and routing

Kodr requests `zdr: true` and `data_collection: "deny"` by default.
These constrain OpenRouter routing; they do not keep requests local.

Use `--openrouter-no-zdr` or `--openrouter-allow-data-collection` to opt out.
`--openrouter-provider-only akashml,parasail` sets upstream provider ordering
through `provider.order`; see `kodr --help` for environment equivalents.
