# Architecture

## Layers

```
Host agent (Claude Code, Cursor, OpenClaw, custom)
        │  MCP (tools/call)
        ▼
mcp-server.mjs | worker/ ← transports (stdio file-backed | HTTP + Durable Object)
        │
mcp-core.mjs            ← tool defs + JSON-RPC dispatch (runtime-agnostic)
        │
orchestrator.mjs        ← providers → proofs: verify, fan-out, decompose, roll-up, compile
   │        providers/  ← jev (TypeSafe), minimax, workers-ai
        │
harness.mjs             ← capacity probe → policy tier (Node only)
        │
jev-core.js             ← question graph, proofs, go/no-go, query, consolidate
```

Providers never decide; they append proofs. The gate in `jev-core.js` is the only place where GO is computed.

- **MCP** owns the wire contract only.  
- **Harness** owns intensity (when to consolidate, soft limits, preferred proof sources).  
- **Core** owns durable logic and serializable state.

## Question graph

Nodes are either:

- **OBSERVATION** — free-form experience (v0.1 behavior)  
- **QUESTION** — gated by `question_spec` + `active_proofs`

### BINARY

One proof with `confidence ≥ threshold` → GO.

### COORDINATED

At least `required_independent_proofs` **independent** proofs, each with `confidence ≥ threshold`, → GO. Proofs that share an independence key (`independence_key`, otherwise `source_type:provider`, otherwise `source_type`) count once.

### Verdicts

`GO`, `OPEN`, `REFUTED` (a live path has confidence ≤ 1 − threshold), `CONFLICT` (both; blocks GO unless `block_on_conflict: false`). Invalidated proofs, proofs older than `max_proof_age_ms`, and sources outside `allowed_sources` are ignored.

### Multi-proof salience

\[
S = 1 - \prod_{k=1}^{M}(1 - P_k)
\]

Independent paths reinforce; invalidating one path does not zero the conclusion if others remain.

## Progressive compilation

1. **Discovery** — heavy LLM produces initial topology + first proof (high `cost_weight`).  
2. **Distillation** — smaller model or tool adds a second path.  
3. **Direct lattice** — go/no-go and query read cached proofs (sub-ms in process).  
4. **Hardware primitive** — sensor / parser tied to the same question framing.

Consolidate marks open COORDINATED nodes with `seeking_verification` so schedulers can prioritize independent proof search.

## Capacity tiers

| Tier | Typical host | Behavior |
|------|----------------|----------|
| minimal | &lt;4GB RAM, constrained edge | Prefer BINARY, cheap sources, tighter prune |
| standard | Laptop / small Jetson | Full graph, moderate consolidate |
| high | Desktop / GPU | Deeper retention, wider stitch |

Override with `JEV_TIER`. Schema is identical across tiers.

## Hermit Crab alignment

- **Shell** = container + capacity (this process, disk, RAM).  
- **Soft tissue** = lattice state (questions, proofs, edges).  

Export state → move to a larger or smaller shell → import. Soft tissue survives; shell is replaceable.

## Browser vs Node

| Surface | Role |
|---------|------|
| `browser/` | Interactive visualizer, download/upload, demo seed |
| `jev-core.js` | Shared pure logic |
| `mcp-server.mjs` | Headless agent integration |
| `harness.mjs` | Policy for headless (browser can ignore or mirror) |

## Non-goals

- Not a full agent loop (host owns the loop).  
- Not a vector DB replacement (spatial coords are light; swap `embed()` later).  
- Not cloud-dependent: core, browser and stdio MCP run offline. Cloudflare and the providers are optional layers.
