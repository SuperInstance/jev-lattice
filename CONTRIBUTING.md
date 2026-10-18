# Contributing

Thanks for working on the lattice. This page is for changes to the core, the providers, the transports and the Worker. For experiments, see [docs/guides/researchers.md](docs/guides/researchers.md).

## Setup
```bash
npm install
npm test                 # must pass offline: no tokens, no network
npm run test:browser     # needs Chromium (Playwright)
```
For live checks, put tokens in your environment (`TYPESAFE_AI_TOKEN`, `MINIMAX_TOKEN`). For the Worker, copy them into `.dev.vars` (gitignored) and run `npm run dev`. Never commit secrets: CI runs GitGuardian.

## Invariants: a change that breaks one of these is a bug
1. **Only `evaluateGoNoGo` decides.** Providers, the orchestrator, senses and agents append or invalidate proofs; they never compute a verdict.
2. **The gate is deterministic** for a given lattice state and `now`. No randomness and no network.
3. **A path's latest reading counts, never its best.** Don't add code that selects among readings ("best of N"), especially on cache-miss paths (drift, expiry, invalidation).
4. **A QUESTION without proofs is never GO.**
5. **The schema is the contract.** New fields are optional and must normalise. `importState` must read every previous schema version, and must reject bad input without mutating the lattice.
6. **Runtime-agnostic modules stay that way.** `jev-core.js`, `orchestrator.mjs`, `proof-cache.mjs`, `compiled.mjs`, `senses.mjs`, `calibration.mjs`, `mcp-core.mjs` and `providers/*` use only `fetch` and WebCrypto: no `node:` imports.
7. **Tools appear only when their provider exists** (`toolDefs({hasJev, …})`).
8. **Model-written code is never executed in-process in production.** Use Dynamic Worker isolates (`worker/predicates.mjs`). `node:vm` is for local experiments only.

The normative gate rules are in [docs/GATE-SEMANTICS.md](docs/GATE-SEMANTICS.md). If you change behaviour, update that document and its conformance checklist in the same PR.

## Where things go
| change | file(s) | tests |
|---|---|---|
| gate rule / spec field | `jev-core.js`, `docs/GATE-SEMANTICS.md`, `mcp-core.mjs` (`SPEC_SCHEMA`) | `tests/regressions.test.mjs` |
| new verifier | `providers/<name>.mjs` (factory + `…ToProof`), then wire it into `mcp-core.mjs` / `worker/index.mjs` | fake provider in `tests/orchestrator.test.mjs` |
| new MCP tool | `mcp-core.mjs` (`toolDefs` + `callTool` + `MUTATING` if it mutates) | `tests/mcp.test.mjs`, `tests/orchestrator.test.mjs` |
| orchestration pattern | `orchestrator.mjs` | offline test with a fake Jev |
| Worker route / DO behaviour | `worker/index.mjs` | `scripts/smoke-worker.mjs` (+ `--live`) |
| browser | `browser/` | `tests/e2e/browser.e2e.mjs` |
| documented example | `examples/*.mjs` | `tests/examples.test.mjs` asserts the output |

## Testing conventions
- Use `node:test` with `node:assert/strict`, one behaviour per test, and a name that states the rule.
- **Fake providers** for anything that would call a model. They should be deliberately noisy when the property under test depends on noise (see `noisyJev` in `tests/proof-cache.test.mjs`).
- **Regression tests must fail on the old code.** Check this before pushing (`git stash`, run the test, `git stash pop`).
- Live and edge checks are scripts, not unit tests: `scripts/smoke-worker.mjs`, `experiments/*`.

## Before you push
- [ ] `npm test` is green, and `npm run test:browser` too if you touched `browser/`
- [ ] `npx wrangler deploy --dry-run --outdir dist` bundles (Node 22)
- [ ] docs updated: README (user-visible behaviour), GATE-SEMANTICS (gate rules), MCP.md (tools), CLOUDFLARE.md (routes/bindings)
- [ ] a new reusable pattern → a tile in `docs/TILES.md`; a measured result → `docs/RESEARCH-LOG.md`
- [ ] no secrets, `.dev.vars` or state files in the diff

## Commit and PR style
Use present-tense subjects that say what changes and why ("Gate uses latest reading per path"). Put measured numbers in the body when a change is motivated by an experiment.
