# Changelog

All notable changes. Versions follow semver once v1.0 is reached; before that, minor versions may change APIs. The state schema stays importable forward.

## 0.7.0
### Added
- **Worker control plane** (`worker/control.mjs`): tenant API keys (D1, only hashes stored), scopes `read ⊂ verify ⊂ admin`, lattice name patterns, per-key rate limits (rate-limiting binding), failed-auth limits per IP, `/admin/keys` and `/admin/events` (root only).
- **Per-lattice settings** (`GET/PUT /api/:lattice/settings`): enabled providers (default: TypeSafe only), default tool profile, quotas (`max_nodes`, `max_proofs_per_node`, `max_proofs`).
- **Audit log** per lattice (Durable Object SQLite): verdict changes per mutating call, with actor and the proofs that caused them; `GET /api/:lattice/audit`, tool `jev_audit`. Also tool `jev_settings`.
- **Tool profiles** `gatekeeper` / `reader` (`JEV_PROFILE`, per key, per lattice); `createMcp({profile, extraTools})` and `handle(msg, ctx)` with `allow` / `guard` hooks.
- **Model pinning**: `JEV_MODEL` everywhere (Worker var `jev-1.13.0`, Action input `model`); MiniMax fallback chain on unknown model ids.
- **API freeze**: `jev-lattice/experimental/{compiled,senses,calibration,grouping}`; TypeScript declarations (`types/`, `npm run typecheck`); gate conformance vectors (`conformance/gate-vectors.json`).
- `grouping.mjs`: Choice-first grouping as a module (`groupCandidates`, `proposeGroups`, `validateGroups`, `createGroupedAsker`).
- `compilePredicate({metamorphic, genRetries})`, `metamorphicRewrites`, `extractCode`.
- `learnThreshold({teacherErrorRate})`, `allowedDisagreements`, `teacherErrorRate` (also on `jev_sense_report` / `jev_apply_learned`).
- Experiments for round 5: model-upgrade, compile-reliability, grouping-repo, auto-tolerance.
### Changed
- Request bodies are size-capped by bytes read, not only by `content-length` (chunked uploads were unbounded).
- Root-path imports of `compiled`, `senses` and `calibration` are deprecated (removed in 1.0).
### Fixed
- GATE-SEMANTICS: the OPEN margin of a COORDINATED gate can be positive.
- Choice-grouping experiment: when two groups mapped one question, the later one overwrote the earlier.

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
