# JEV Lattice v0.3

**A graph of questions with explicit proof contracts.** Go/no-go is a deterministic lattice read, not an LLM opinion. Proofs come from cheap and expensive verifiers, which compound when they are independent, and the system compiles itself toward the cheapest path that still holds.

```
          ┌──────────── proof providers (append proofs, never decide) ────────────┐
          │  TypeSafe Jev     JEV_NOUL              cost 0.05   ~100 ms, calibrated │
          │  MiniMax          LLM_CHAIN_OF_THOUGHT  cost 0.85   ~5–40 s, discovery   │
          │  Workers AI       SMALL_MODEL           cost 0.15   edge, overconfident  │
          │  compiled code    DETERMINISTIC_PARSER  cost 0.01   µs, written by MiniMax│
          │  roll-up          LATTICE_READ          cost 0.01   children all GO       │
          └────────────────────────────────┬──────────────────────────────────────┘
                                           ▼
   jev-core.js  ── QUESTION { question_spec, active_proofs } ──▶ evaluateGoNoGo → GO | OPEN | REFUTED | CONFLICT
                                           │
         ┌─────────────────┬───────────────┴──────────┬──────────────────────────┐
     browser/          mcp-server.mjs             worker/ (Cloudflare)       orchestrator.mjs
     canvas UI        stdio MCP + harness     Durable Object per lattice    verify · fan-out · decompose
     + edge sync      (any MCP host)          MCP over HTTP · alarms        roll-up · compile loop
```

Same schema (`jev-lattice/v0.3`, reads v0.2) everywhere. State is portable JSON.

## Quick start

```bash
npm install          # only dev dependency: wrangler
npm test             # offline: 30 v0.2 assertions + 40 node:test cases (regressions, orchestrator, proof cache, MCP stdio e2e)
npm run example      # progressive compilation demo, no network

# live (needs TYPESAFE_AI_TOKEN and/or MINIMAX_TOKEN)
npm run live:compile          # Jev → MiniMax → decompose → fan-out → roll-up, then config drift
npm run live:calibration      # verifier calibration bench vs code-computed ground truth
npm run live:compile-parser   # MiniMax writes parsers, Jev grades them, held-out test
npm run live:proof-cache      # multi-turn agent workload: naive vs hash-invalidation vs cache

npm run mcp          # MCP stdio server (state → ./jev-state.json)
npm run dev          # Worker + Durable Object locally (secrets in .dev.vars)
npm run deploy       # Cloudflare
```

## Gate semantics

| `question_spec` field | Meaning |
|---|---|
| `evaluation_mode` | `BINARY`: one proof ≥ threshold. `COORDINATED`: `required_independent_proofs` independent proofs ≥ threshold |
| `confidence_threshold` | default 0.85 (0 is honoured) |
| `max_proof_age_ms` | proofs older than this stop counting (deterministic given `now`) |
| `allowed_sources` | only these `source_type`s may close the gate |
| `block_on_conflict` | default `true`: a confident "no" alongside enough "yes" paths blocks GO |

**Independence.** Proofs that share an independence key form one path: `independence_key` if set, otherwise `source_type:provider`, otherwise `source_type`. A path's current reading is its **latest** live proof, not its best, so re-asking a non-deterministic verifier can't cherry-pick a pass. Adding the same parser twice can't fake a COORDINATED gate.

**Verdicts.**
- `GO`: enough independent paths are at or above the threshold.
- `OPEN`: not enough evidence yet.
- `REFUTED`: some path is at or below 1 − threshold.
- `CONFLICT`: both of the above at once.

**Invalidation.** `invalidateProof(nodeId, proofId, reason)` kills one path, for example when its config changed. The gate re-evaluates on the paths that remain, and the dead proof stays on record for audit.

A QUESTION without a spec gets a BINARY gate. It is never an implicit GO.

## Tools

The core tools are available everywhere: `window.JEV.call`, `createToolRegistry`, MCP stdio, and MCP-over-HTTP.

| MCP tool | Role |
|---|---|
| `jev_ingest` | Observation or QUESTION (+ `question_spec`, initial `proof`) |
| `jev_add_proof` / `jev_invalidate_proof` | Add or kill a verification path |
| `jev_invalidate_stale` | Drift: retire proofs whose recorded evidence hash (per `channel`) no longer matches |
| `jev_evaluate_go_no_go` | Deterministic gate + verdict |
| `jev_query` | Spatial + probabilistic beam, prefers closed / cheap paths |
| `jev_consolidate` | Idle cycle: stitch, merge, prune, tag `seeking_verification` |
| `jev_rollup` | Children all GO → parent gets a `LATTICE_READ` proof (no model call) |
| `jev_stats`, `jev_list_nodes`, `jev_get_node`, `jev_boost`, `jev_prune` | Housekeeping |
| `jev_export_state` / `jev_import_state` | Portable snapshot |
| `jev_capacity` | Harness probe (stdio server only) |

These provider tools appear only when their provider is configured:

| MCP tool | Provider |
|---|---|
| `jev_verify` | Jev Noul on one question; `state` defaults to the lattice neighbourhood |
| `jev_verify_open` | **Speculative fan-out**: every open gate in one Jev request |
| `jev_minimax_proof` | MiniMax CoT judgement |
| `jev_decompose` | MiniMax → atomic BINARY child questions |
| `jev_compile` | Jev first → MiniMax → decompose + fan-out → roll-up; stops when decided (`stopOn`) |
| `jev_edge_proof` | Workers AI small model (Worker only) |

## Deployment surfaces

| Surface | Where | Notes |
|---|---|---|
| Browser | `browser/` (serve the repo root; ES modules don't load from `file://`) | Push, pull, and "Verify open gates (Jev)" against an edge lattice |
| MCP stdio | `mcp-server.mjs` | Env: `JEV_STATE_PATH`, `JEV_TIER`, `TYPESAFE_AI_TOKEN`, `MINIMAX_TOKEN`, `JEV_NO_PROVIDERS=1` |
| Cloudflare | `worker/index.mjs`, `wrangler.jsonc` | `POST /mcp/:lattice`, `/api/:lattice/*`, UI at `/browser/`; see [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) |

## What the experiments found

Full numbers are in [docs/RESEARCH-LOG.md](docs/RESEARCH-LOG.md). Reusable patterns are in [docs/TILES.md](docs/TILES.md).

- **Jev as gate verifier.** It got 99.0–99.7% accuracy on 600 code-labelled config questions, with **0 wrong GOs** at thresholds 0.8, 0.9 and 0.95. A batch of 300 questions came back in 0.3–0.6 s total.
- **Reading rules belong in `state`.** Jev missed "later directive overrides earlier" traps until the rule was sent in `state`.
- **Workers AI llama-8b** is useful as a second path but unsafe alone: 5 wrong GOs at 0.9. Pairing it COORDINATED with any other source produced 0 wrong GOs.
- **Compiling to code.** MiniMax wrote predicates for 10 questions. 9 passed self-verification against confident Jev labels and then scored 100% on held-out configs. The 10th was correctly *rejected* for having too few confident labels.
- **MiniMax as a code reviewer** reported 7 "bugs"; 1.5 were real. Treat its findings as claims to verify, not as fixes.
- **Jev is not bit-deterministic.** 7% of gates flip GO↔OPEN at 0.9 when re-asked. The **proof cache** (`proof-cache.mjs`) makes same-evidence-same-verdict hold, with 0 flips, and sends 66–73% fewer Jev questions on a multi-turn agent workload.

## Layout

```
jev-core.js            lattice + gate (no deps; browser, Node, Workers)
orchestrator.mjs       providers → proofs; fan-out, decompose, roll-up, compile loop, drift invalidation
proof-cache.mjs        content-addressed verifier answers (memory / Durable Object storage)
mcp-core.mjs           transport-agnostic MCP tool defs + JSON-RPC dispatch
mcp-server.mjs         stdio transport + capacity harness + file persistence
harness.mjs            capacity probe → minimal / standard / high policy
providers/             jev.mjs (TypeSafe) · minimax.mjs (+ CLI) · workers-ai.mjs
worker/index.mjs       Worker + LatticeDO (Durable Object, alarms)
browser/               canvas UI + edge sync
experiments/           live-compile · calibration · compile-parser · proof-cache · redis-gen
tests/                 node:test suites + e2e/browser.e2e.mjs (Playwright)
docs/                  ARCHITECTURE · MCP · CLOUDFLARE · TILES · RESEARCH-LOG
```

## Design rules

1. **Go/no-go is deterministic.** Providers only append proofs.
2. **Independent proofs compound; duplicate paths don't.** One path can die without taking the conclusion with it.
3. **Compile toward cheaper edges.** Heavy CoT is for discovery. The steady state is a parser or a lattice read.
4. **State is the contract.** Download it, upload it, and any host can reimplement the tools.
5. **Harness sets intensity only.** The schema is the same on a phone and a workstation.

## License

MIT
