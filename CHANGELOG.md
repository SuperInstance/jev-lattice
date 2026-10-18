# Changelog

All notable changes. Versions follow semver once v1.0 is reached; before that, minor versions may change APIs. The state schema stays importable forward.

## 0.6.0
### Added
- `jev` CLI (`gate`, `check-config`, `mcp`, `version`) and `gate.mjs`: config-driven gating that fails closed and persists state between runs. Proofs on unchanged files cost nothing.
- GitHub Action (`action.yml`), with state kept in `actions/cache` and a job-summary table.
- Gate: `require_firm` (opt-in; a fragile verdict needs corroboration) and `needs_corroboration` / `held` in the results; `firmUp` in the orchestrator.
- `learnThreshold({tolerance})` for noise-aware cross-sense learning.
- Worker: request-size limit (`JEV_MAX_BODY_BYTES`).
- Experiments for round 4: metamorphic validation, noisy teacher, fragility-aware gates, agent v2, Choice-first grouping.
- Docs: `docs/PRODUCTION.md`, `docs/guides/ci-gates.md`, `SECURITY.md`.
### Changed
- MCP tool arguments are validated against each tool's `inputSchema` before dispatch; errors come back as `isError` with a path.
- `consolidate()` uses a spatial grid, a `maxDegree` cap (default 16) and batched merge remapping: 27–67× faster at 500 nodes.
- npm package ships only product files (36 files, 259 kB).
- `createMiniMax()` honours `MINIMAX_TIMEOUT_MS`.

## 0.5.0
- Per-file evidence channels (`reads`), cross-sense teaching (`senses.mjs`), `margin` / `fragile` + `stabilityProbe`, `blocked_sources`, `fragility_band`, Jev long-context option, MiniMax Flash default; full documentation set.

## 0.4.0
- Compiled predicates (refute-only trust), `source_thresholds`, Choice/Score proofs, sandboxed edge predicates (Dynamic Workers), drift detector, MiniMax agent experiments.

## 0.3.1
- Proof cache with state-hash drift invalidation; the gate uses the latest reading per path (not the best).

## 0.3.0
- Gate-safety fixes from the v0.2 intake; verdicts (GO/OPEN/REFUTED/CONFLICT); Jev, MiniMax and Workers AI providers; MCP core; Cloudflare Worker + Durable Object.
