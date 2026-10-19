# Changelog

All notable changes. Versions follow semver once v1.0 is reached; before that, minor versions may change APIs. The state schema stays importable forward.

## 0.11.0
### Added
- `jev gate --compare-model <id>` / `compareModels()`: a model-upgrade rehearsal. Every gate is evaluated from scratch with the current and the candidate model on the same files, and the verdicts that would move are listed (nothing is saved; `--fail-on-change` exits 1 if any move). GitHub Action input `compare-model` adds the rehearsal to the job summary without affecting the gate.
### Measured
- Live rehearsal, 50 gates over generated redis/nginx/env/YAML files with 0.8+ evidence framing: jev-1.13.0 → jev-1.14.0 moved **0/50** verdicts (26 GO, 24 REFUTED, none fragile). R5-E's bare-state bench moved 4.7–6.2%.

## 0.10.0
### Security
- `facts.mjs`: the flat `key` matcher took the *last* line with that key anywhere in a file. In YAML, an attacker-added nested key (`overrides: {server: {read_timeout: 500ms}}`) therefore became the "trusted" fact, and Jev followed it (4 of 20 wrong GOs). New: the `yaml` extractor and `path` for `size`/`duration` (a dotted path in a YAML block mapping). Fact specs that use `key` on a `.yml`/`.yaml` file are now **rejected** by `jev check-config`, `jev gate` and `jev_verify_files`.
### Added
- `GET /admin/health` (root): D1, R2, Durable Object and TypeSafe checks, with latencies.
- `POST /admin/lattices {names}` (root): register lattices created before 0.9 for backup.
- `scripts/metrics-report.mjs`: per-route requests, p50/p95 and 5xx counts from Analytics Engine, checked against the SLOs (exit 1 on a breach). The `slo` workflow runs it hourly.
### Fixed
- GitHub Action: the "Fail when gates are not GO" step now has `always()`. Without a status function GitHub implies `success()`, which skipped the step, and its error annotation, exactly when the gate failed.

## 0.9.1
### Fixed
- GitHub Action: the Evaluate step now exits with the verifier's status, and the gate keys on the step outcome. Before, `set +e` made the step exit 0 on REFUTED, and a skipped step's missing outputs (null, which coerces to 0) let a gate that never ran pass (#4).
- `package.json`: `bin` paths normalised (`npm pkg fix`), which silences the publish warning.

## 0.9.0
### Added
- Worker: daily backups of every lattice to R2 (cron), with 30-day retention; `POST /admin/backup`, `GET /admin/backups/:name`, `POST /admin/restore/:name` (audited); a lattice registry (`GET /admin/lattices`).
- Worker: a staging environment (`npm run deploy:staging`); Analytics Engine metrics per request; `x-request-id` on every response; JSON logs for unhandled errors.
- Keys: `expires_in_days`, `expires_at`, `last_used_at`.
- `scripts/load-worker.mjs`; `docs/RUNBOOK.md`.
- CI: main → staging → smoke test → production; a `release` workflow that publishes to npm with provenance.
### Fixed
- `importState`: nodes without coordinates were all placed at [0, 0], so consolidate merged unrelated observations (data loss) and ran quadratically (3.5 s at 5000 nodes, now 0.26 s).
- `consolidate()`: exact ring-based k-nearest search; output identical to 0.8, up to 3.4× faster on clustered lattices.
- Audit: the "before" snapshot is reused, about halving write latency on large lattices.

## 0.8.0
### Added
- `facts.mjs`: trusted extractors (`directive`, `size`, `duration`, `env`, `json`, `count`, `regex`); `facts` in `jev.gates.json`, `verifyFiles({facts})` and `jev_verify_files`.
- `frameEvidence` (file descriptions, `quarantine`, `strip`), `stripComments`, `describeFile`, `jevQuestion`.
- `question_spec.focus` and `question_spec.criteria`, sent to Jev as structured instructions and Noul criteria; per-gate `focus` and `criteria` in the gate config.
- `jev lint` / `lintGates`: evidence-blind probe, wide `reads`, negated phrasing.
- Providers: `providers/groq.mjs`, `providers/deepseek.mjs` (prefix-cache accounting, `withPrefix`), and the shared `providers/openai-compatible.mjs`.
- Jev provider: gzip request bodies of 16 KB or more; `max_tokens_exceeded` hint; request id in errors.
- `docs/guides/typesafe.md`; round 6 experiments (`experiments/typesafe-*.mjs`, `hard-gen.mjs`).
### Changed
- **Comments are stripped before Jev reads files, by default** (`strip_comments: false` opts out). Adaptive comment-only injections produced 13–19% wrong GOs without it, 0% with it.
- `verifyFiles` describes each file by type.
### Fixed
- `facts.mjs` `directive`/`size`/`duration`: nginx-style `;` terminators (found by a MiniMax-M3 review).

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
