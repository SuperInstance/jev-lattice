# Production readiness, deployment and packaging

Status as of v0.6.0. This document gives an honest split between what is production-grade, what is beta and what is research, followed by the deployment shape, the packaging plan, and the remaining work, in priority order.

## 1. What is production-grade, beta, or research

| Component | Status | Why |
|---|---|---|
| Gate (`jev-core.js` `evaluateGoNoGo`) | **production** | Deterministic; a normative spec ([GATE-SEMANTICS.md](GATE-SEMANTICS.md)); regression tests for every bug found; no I/O |
| Proof cache, per-file evidence, drift invalidation | **production** | Measured (66–73% fewer calls, 0 flips on unchanged evidence; 72% fewer questions with higher accuracy); unit-tested |
| `jev gate` CLI + GitHub Action | **production (new)** | Fails closed (missing files, verifier errors and OPEN are all not-GO); state persisted between runs; tested with a fake verifier and live against Jev |
| MCP core + stdio server | **production** | Protocol negotiation, argument validation against each tool's schema (new in v0.6), atomic persistence, end-to-end tests |
| Jev provider | **production** | Retries/backoff on 429/529/5xx, timeouts, long-context option |
| Cloudflare Worker / Durable Object | **beta** | Works and is smoke-tested in production; lacks per-tenant auth, rate limits, an audit log and backups (§4) |
| Edge predicates (Dynamic Workers) | **beta** | Depends on a Cloudflare open-beta API |
| Cross-sense teaching (`senses.mjs`) | **beta** | Measured safe (0 wrong GOs with the floor), but needs teacher error rates wired in (T37) |
| Compiled predicates (`compiled.mjs`), calibration maps, `compile`/`decompose` (MiniMax) | **research** | Useful, but model-written code needs metamorphic acceptance (T36) and a retry loop; not part of the v1 API |
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
| **npm `jev-lattice`** | core, orchestrator, cache, gate, MCP, providers, CLI (`jev`, `jev-mcp`), Worker sources, examples, product docs: **36 files, 259 kB, zero runtime dependencies**. Experiments, tests and R&D notes are excluded (`files` whitelist). | `npm publish --provenance` from CI on a tag | ready (`prepublishOnly` runs the tests) |
| **GitHub Action** | `action.yml` (composite: setup-node, cache restore, `jev gate`, cache save, job summary) | `uses: SuperInstance/jev-lattice@v0.6` | ready; Marketplace listing later |
| **Cloudflare template** | `wrangler.jsonc` + `worker/` + `npm run deploy` | repo / "Deploy to Cloudflare" button | ready for self-hosting; multi-tenant hosting needs §4 |
| **MCP listing** | `jev mcp` stdio server; remote URL for JEV Edge | MCP registries | after the v1 API freeze |
| Container image | not planned: Node ≥ 20 with zero dependencies runs anywhere; build one only for air-gapped MCP hosts | — | — |

**Versioning policy:**
- Semver applies to `jev-lattice` (gate core, orchestrator verify functions, cache, gate/CLI, MCP tool names and arguments), the state schema (`jev-lattice/vX.Y`, always importable forward), and the gate semantics.
- Before **v1.0**, research modules move under `jev-lattice/experimental/*` so they can change freely.

## 4. Remaining work (prioritised)

### P0: before v1.0 or before serving anyone outside the team
1. **Per-tenant auth and scopes on the Worker.** Today there is one shared bearer key. Store hashed keys (D1) with scopes (`read`, `verify`, `admin`) and per-lattice access lists.
2. **Rate limits and quotas.** Use Cloudflare's rate-limiting binding per key, and per-lattice caps on nodes, proofs per node and calls per minute. *Measured reason:* `consolidate()` on a clustered 20k-node lattice takes ~37 s (0.4 s when spread out), so lattice size needs a budget.
3. **Audit log of verdict changes.** Gates are decisions people act on. Record an append-only log of (lattice, question, verdict before/after, deciding proofs, actor, time), in D1 or R2.
4. **Data-flow controls.**
   - Each lattice declares which providers may see its evidence (`providers: ["typesafe"]`); the default sends nothing to MiniMax or Workers AI.
   - Document exactly what is sent where: evidence files go to TypeSafe; proofs, questions and paraphrases go to MiniMax.
5. **API freeze.**
   - Move research modules under `experimental/`.
   - Add TypeScript declarations (JSDoc → `tsc --declaration`).
   - Publish the GATE-SEMANTICS conformance checklist as an exported test suite that other implementations can run.
6. **Model pinning.** `MiniMax-M3.1-Flash-Preview` isn't listed by `/v1/models`. Production should pin a listed model by default and fall back gracefully. `jev-latest` should likewise be pinnable (`JEV_MODEL`) so verdicts don't shift silently under a model alias change; the cache TTL already bounds this.

### P1
- **Observability:** structured logs and Workers Analytics Engine metrics: verdicts, fragile rate, provider latency, errors, cost, cache hit rate.
- **Backups:** a scheduled export of every Durable Object's state to R2. **Environments:** `staging` and `production` in `wrangler.jsonc`, with gradual deployments.
- **Incremental consolidation**, bounded per alarm, instead of whole-lattice passes.
- **Load test** the Durable Object: concurrent MCP sessions on one lattice, a large `verify_files` batch, storage at about 10k nodes.
- **Curated tool profiles** (`?profile=gatekeeper`) on both transports.

### P2
- Productise Choice-first grouping (T40) and metamorphic acceptance for predicates (T36).
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

## 6. Failure modes and how they resolve
| Failure | Behaviour |
|---|---|
| Jev unreachable or 5xx | Retries with backoff, then the gate stays as it was. Unverified gates are OPEN, which is never GO; the CLI exits 1. |
| A file is missing | The gate for that file is not GO, with the reason "missing file". |
| A verifier answer changes on re-ask | The cache returns the first answer for the same evidence. `margin` / `fragile` flag readings close to the bar. |
| An agent records spurious proofs | Use curated tool profiles; `allowed_sources` / `blocked_sources` per question; an audit log (P0). |
| A model alias moves | The cache TTL bounds stale answers; pin the model (P0). |
| A Durable Object is lost or corrupted | Restore from the R2 backup (P1); the state is plain JSON (`importState` validates it). |
