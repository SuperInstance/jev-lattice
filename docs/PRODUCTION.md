# Production readiness, deployment and packaging

Status as of v0.7.0. (v0.7 completed the P0 list from the v0.6 review; §4 records how each item was done.) This document gives an honest split between what is production-grade, what is beta and what is research, followed by the deployment shape, the packaging plan, and the remaining work, in priority order.

## 1. What is production-grade, beta, or research

| Component | Status | Why |
|---|---|---|
| Gate (`jev-core.js` `evaluateGoNoGo`) | **production** | Deterministic; a normative spec ([GATE-SEMANTICS.md](GATE-SEMANTICS.md)); regression tests for every bug found; no I/O |
| Proof cache, per-file evidence, drift invalidation | **production** | Measured (66–73% fewer calls, 0 flips on unchanged evidence; 72% fewer questions with higher accuracy); unit-tested |
| `jev gate` CLI + GitHub Action | **production (new)** | Fails closed (missing files, verifier errors and OPEN are all not-GO); state persisted between runs; tested with a fake verifier and live against Jev |
| MCP core + stdio server | **production** | Protocol negotiation, argument validation against each tool's schema, tool profiles, per-request authorisation hooks, atomic persistence, end-to-end tests |
| Jev provider | **production** | Retries/backoff on 429/529/5xx, timeouts, long-context option, model pinning (`JEV_MODEL`) |
| Cloudflare Worker / Durable Object | **beta → production candidate** | Tenant keys with scopes, per-key rate limits, quotas, an audit log of verdict changes, per-lattice provider allowlists; 49 live smoke checks. Still missing before GA: backups, metrics, staging environment (P1) |
| Edge predicates (Dynamic Workers) | **beta** | Depends on a Cloudflare open-beta API |
| Cross-sense teaching (`experimental/senses`) | **beta** | Measured safe (0 wrong GOs with the floor); teacher error rate → tolerance is now automatic (`teacherErrorRate`, R5-C), safe up to ~5% teacher noise |
| Compiled predicates (`experimental/compiled`), calibration maps, `compile`/`decompose` (MiniMax) | **research** | Metamorphic acceptance and code regeneration are now built in (R5-A); still model-written code, not part of the v1 API |
| Choice-first grouping (`experimental/grouping`) | **beta** | Generalised from redis.conf to nginx/env files (R5-B): 0 wrong GOs, recall 0.978 → 1.000, 31% fewer questions; model proposes, Jev's own Nouls validate |
| Browser UI | **demo** | Functional, not designed for operators |

## 2. Deployment shape

Three distribution tiers share one core. Each tier is useful on its own; adoption should go in this order.

```
                      ┌──────────────────────── jev-lattice (npm) ────────────────────────┐
  Tier 1  CI gates    │ jev gate CLI ── GitHub Action (actions/cache keeps state)         │ ──▶ TypeSafe API
  Tier 2  Agents      │ jev mcp (stdio) — Claude Code, Cursor, any MCP host               │ ──▶ TypeSafe API (+ MiniMax optional)
                      └───────────────────────────────────────────────────────────────────┘
  Tier 3  Shared/edge   JEV Edge: Cloudflare Worker + Durable Object per lattice          ──▶ TypeSafe, Workers AI, MiniMax
                        MCP over HTTP · REST · drift watches (alarms) · sandboxed predicates
```

**Tier 1, CI gates (recommended first deployment).**
- A team adds `jev.gates.json` and the action to a workflow; that is the whole setup.
- No service to run. Data leaves only for the verifier (the files that each question reads).
- Cost scales with *changed* files, not with runs.
- See [guides/ci-gates.md](guides/ci-gates.md).

**Tier 2, agents.** The same package, via `jev mcp`. Give agents the curated tool profile (T39). An agent's recorded proofs become evidence for later decisions, so a narrow surface is a safety feature, not just a cost saving.

**Tier 3, JEV Edge (shared lattices).** Use this when several agents or pipelines must share decisions and watch configs continuously. It is hosted on Cloudflare (Workers + Durable Objects + Workers AI + Dynamic Workers). This tier needs the P0 work in §4 before it serves anyone outside the team.

## 3. Packaging

| Artifact | Contents | Channel | Status |
|---|---|---|---|
| **npm `jev-lattice`** | core, orchestrator, cache, gate, MCP, providers, CLI (`jev`, `jev-mcp`), Worker sources, TypeScript declarations, conformance vectors, examples, product docs: **zero runtime dependencies**. Experiments, tests and R&D notes are excluded (`files` whitelist). | `npm publish --provenance` from CI on a tag | ready (`prepublishOnly` runs the tests) |
| **GitHub Action** | `action.yml` (composite: setup-node, cache restore, `jev gate`, cache save, job summary) | `uses: SuperInstance/jev-lattice@v0.6` | ready; Marketplace listing later |
| **Cloudflare template** | `wrangler.jsonc` + `worker/` + `npm run deploy` | repo / "Deploy to Cloudflare" button | ready for self-hosting; multi-tenant hosting needs §4 |
| **MCP listing** | `jev mcp` stdio server; remote URL for JEV Edge | MCP registries | after the v1 API freeze |
| Container image | not planned: Node ≥ 20 with zero dependencies runs anywhere; build one only for air-gapped MCP hosts | — | — |

**Versioning policy:**
- Semver applies to `jev-lattice` (gate core, orchestrator verify functions, cache, gate/CLI, MCP tool names and arguments), the state schema (`jev-lattice/vX.Y`, always importable forward), and the gate semantics.
- Research modules live under `jev-lattice/experimental/*` (compiled, senses, calibration, grouping) and may change in any release. The old root paths (`jev-lattice/compiled` etc.) still resolve in 0.7 and are removed in 1.0.
- Stable entry points ship hand-written TypeScript declarations (`types/`), checked by `npm run typecheck` and by a test that every declared value exists at runtime.
- Gate semantics are pinned by `conformance/gate-vectors.json`: 27 cases with hand-computed expectations. Other implementations run the same file.

## 4. Remaining work (prioritised)

### P0: done in v0.7
| Item | How it was done | Evidence |
|---|---|---|
| Per-tenant auth and scopes | `worker/control.mjs`: keys `jev_<id>_<secret>`, only sha256(secret) stored in D1 (`CONTROL`). Scopes are cumulative (`read ⊂ verify ⊂ admin`). Each key lists lattice name patterns (default `<tenant>-*`). The deployment secret `JEV_API_KEY` is the root key and the only one that can manage keys (`/admin/keys`). | `tests/control.test.mjs`; smoke: read key sees 9 tools, gets 403 on ingest, other lattices and settings; revoked key → 401 |
| Rate limits and quotas | Workers rate-limiting binding, per key, 50 requests / 10 s (root exempt). Per-lattice `max_nodes` (5000), `max_proofs_per_node` (200), `max_proofs` (20 × nodes); refused calls return 429 with a `quota:` reason. | smoke: limiter returned 429 for 37 of 300 rapid requests (it is permissive and eventually consistent by design); max_nodes enforced |
| Audit log | SQLite table in each lattice's Durable Object: one row per mutating call (actor, tool, ok, verdict changes with the proofs that caused them), including the idle cycle and drift watches. Last 10,000 rows kept. `GET /api/:lattice/audit`, tool `jev_audit`. | smoke: `OPEN→REFUTED` by `jev_predicate_proof`, refused quota calls logged `ok: false` |
| Data-flow controls | `settings.providers` per lattice; default from `JEV_DEFAULT_PROVIDERS` = `typesafe` only. MiniMax, Workers AI and predicates are opt-in (`PUT /api/:lattice/settings`, admin). See the data-flow table in §5.1. | smoke: unknown provider rejected; tools appear only when enabled |
| API freeze | `experimental/*` exports; `types/*.d.ts` + `npm run typecheck`; `conformance/gate-vectors.json` + runner. | `tests/types.test.mjs`, `tests/conformance.test.mjs` |
| Model pinning | `JEV_MODEL` (Worker var `jev-1.13.0`, Action input `model`, CLI/stdio env). MiniMax: a fallback chain on unknown-model errors (status 2013), Flash → M3. *Measured reason* (R5-E): 1.13.0 → 1.14.0 flips 4.7–6.2% of verdicts, 2–2.5× the re-ask rate, with 3× the mean change in p. | `experiments/results/model-upgrade-s*.json` |

### P1
- **Observability:** structured logs and Workers Analytics Engine metrics: verdicts, fragile rate, provider latency, errors, cost, cache hit rate.
- **Backups:** a scheduled export of every Durable Object's state to R2. **Environments:** `staging` and `production` in `wrangler.jsonc`, with gradual deployments.
- **Incremental consolidation**, bounded per alarm, instead of whole-lattice passes.
- **Load test** the Durable Object: concurrent MCP sessions on one lattice, a large `verify_files` batch, storage at about 10k nodes.

- **Audit export:** stream audit rows to R2 or a customer sink; today they live (and die) with the Durable Object.
- **Key rotation UX:** expiry dates and last-used timestamps on keys.

### P2
- Run Choice-first grouping automatically inside `jev gate` (the module and its auto-trigger exist; the CLI does not call them yet).
- An operator UI (beyond the demo canvas); a docs site.

### Done in v0.6 (from this review)
- **Tool-argument validation:** before, `{"text": 42}` leaked an internal error and `question_spec: "nope"` silently created a gate.
- **`consolidate()` rewritten:** a spatial grid, a degree cap and batched merge remapping. **27–67× faster at 500 nodes** (3.6 s → 54 ms); spread lattices are roughly linear (20k nodes in 0.43 s).
- **Worker request-size limit** (`JEV_MAX_BODY_BYTES`, default 4 MiB).
- **CLI + GitHub Action, npm `files` whitelist, CHANGELOG, SECURITY policy.**

## 5. Operating cost model (from measurements)
- **One Jev call answers many questions over one state.** In the calibration bench that was ~53 input tokens per question for a small config, because the state is shared across the batch.
- **Steady state costs almost nothing.** With per-file channels and the proof cache, a CI run with no changed files makes **0** verifier calls. A run with one changed file asks only the gates that read it.
- **MiniMax is the expensive path** (seconds per call, many output tokens). It is used for one-off design-time work (decomposition, predicates, grouping), not per run.
- **The Worker:** a Durable Object is active per lattice while requests or alarms are running; the idle cycle runs at most once per 10 quiet minutes.

### 5.1 What is sent where
| Destination | What it receives | When |
|---|---|---|
| TypeSafe (Jev) | the evidence state (files a question `reads`, or the state passed to a tool), reading rules, question text | verification calls; skipped when the proof cache has the answer |
| MiniMax | question text, evidence (for `jev_minimax_proof`, compilation, rewrites, paraphrases) | only on lattices with `minimax` enabled, or in local tools you run |
| Workers AI | question text and evidence | only with `workers-ai` enabled; runs inside Cloudflare |
| Dynamic Worker isolate | predicate code and evidence text | only with `predicates` enabled; no network (`globalOutbound: null`) |
| Cloudflare D1 | key id, sha256 of the secret, tenant, scopes, lattice patterns | key management |
| Durable Object storage | lattice state, proof cache, audit log, settings | always (per lattice) |

## 6. Failure modes and how they resolve
| Failure | Behaviour |
|---|---|
| Jev unreachable or 5xx | Retries with backoff, then the gate stays as it was. Unverified gates are OPEN, which is never GO; the CLI exits 1. |
| A file is missing | The gate for that file is not GO, with the reason "missing file". |
| A verifier answer changes on re-ask | The cache returns the first answer for the same evidence. `margin` / `fragile` flag readings close to the bar. |
| An agent records spurious proofs | Give its key `verify` scope and the `gatekeeper` profile; `allowed_sources` / `blocked_sources` per question; the audit log shows which call moved which verdict. |
| A model alias moves | Production pins `JEV_MODEL`; the cache key includes the model, so an upgrade never serves old answers as new ones. |
| A key leaks | `DELETE /admin/keys/:id` revokes it at once; its blast radius is its scopes × its lattice patterns. |
| A Durable Object is lost or corrupted | Restore from the R2 backup (P1); the state is plain JSON (`importState` validates it). |
