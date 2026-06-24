# Next

## Repository settings

- Enable secret scanning, push protection, Dependabot alerts, and code scanning.
- Protect `main` with required CI checks and pull-request review.
- Add issue and pull-request templates once contribution patterns are established.
- Decide whether a formal code of conduct is needed before inviting broad contributions.

## Releases

- Decide the initial public version and publish `kodr` to npm.
- Add an npm provenance-enabled release workflow after the first manual release is validated.
- Adopt a changelog and release-note convention.
- Document the LM Studio models and versions used for release evals.

## Testing

- Track live-eval pass rates across supported local models.
- Add Windows coverage if `/bin/sh` command execution becomes portable.
- Add adversarial evals for malformed and repeated model tool calls.
- Consider a longer-running tool-turn exhaustion eval outside required CI.
