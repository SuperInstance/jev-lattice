# JEV Lattice v0.2

**Spatial graph of questions and verification paths** — deterministic go/no-go, multi-proof salience, progressive compilation, capacity-aware MCP harness.

Browser-native UI + Node core + MCP server. Same schema everywhere. State is portable JSON.

## Why

Linear chain-of-thought is brittle: invalidate one step and the path collapses.  
JEV stores **questions** with explicit contracts:

| Mode | Meaning |
|------|---------|
| **BINARY** | One proof ≥ threshold closes the gate |
| **COORDINATED** | *k* independent proofs ≥ threshold required |

Multiple independent proofs reinforce the same conclusion (multi-proof salience). Expensive LLM paths can be compiled into cheaper parsers, sensors, or lattice reads over time. Go/no-go is a **lattice query**, not an LLM opinion.

## Quick start

```bash
# Tests (no deps)
node tests/core.test.mjs

# Progressive compilation demo
node examples/compile-loop.mjs

# Browser UI
# Open browser/index.html (or serve the folder)

# MCP server (stdio JSON-RPC)
node mcp-server.mjs
# State file: ./jev-state.json (or JEV_STATE_PATH)
```

### MCP client config (example)

```json
{
  "mcpServers": {
    "jev-lattice": {
      "command": "node",
      "args": ["/absolute/path/to/jev-lattice/mcp-server.mjs"],
      "env": {
        "JEV_STATE_PATH": "/absolute/path/to/jev-state.json",
        "JEV_TIER": "standard"
      }
    }
  }
}
```

## Tools (MCP + `window.JEV` / `createToolRegistry`)

| Tool | Role |
|------|------|
| `jev_ingest` / `ingest` | Observation or QUESTION (+ optional `question_spec`, initial `proof`) |
| `jev_add_proof` / `addProof` | Append independent verification path |
| `jev_evaluate_go_no_go` / `evaluateGoNoGo` | Deterministic gate |
| `jev_query` / `query` | Spatial + probabilistic beam (prefers closed / low-cost) |
| `jev_consolidate` / `consolidate` | Idle: stitch, merge, prune, mark seeking |
| `jev_stats` / `stats` | Counts + open gates (+ capacity when via MCP) |
| `jev_export_state` / `exportState` | Full JSON snapshot |
| `jev_import_state` / `importState` | Restore snapshot |
| `jev_capacity` | Harness probe + policy tier |

## Capacity-aware harness

`harness.mjs` probes RAM/CPU (or `JEV_TIER=minimal|standard|high`) and sets policy:

- **minimal** — prefer BINARY + cheap proofs, tighter prune  
- **standard** — full question graph (default)  
- **high** — deeper retention, wider stitch  

Schema never changes by tier — only intensity. Export state from a high-tier machine and import on a minimal node; the constrained host simply refuses expensive work and still serves go/no-go + query.

## Schema `jev-lattice/v0.2`

Optional fields (omit → free-form observation):

```json
{
  "node_type": "QUESTION",
  "question_spec": {
    "evaluation_mode": "COORDINATED",
    "required_independent_proofs": 2,
    "confidence_threshold": 0.88,
    "intent": "…"
  },
  "active_proofs": [
    {
      "proof_id": "…",
      "source_type": "LLM_CHAIN_OF_THOUGHT | DETERMINISTIC_PARSER | SENSOR | SMALL_MODEL | LATTICE_READ",
      "confidence": 0.91,
      "cost_weight": 0.85,
      "timestamp": "…"
    }
  ]
}
```

Multi-proof salience: \(1 - \prod_k (1 - P_k)\).

## Layout

```
jev-lattice/
├── jev-core.js          # Pure lattice + tools (browser + Node)
├── harness.mjs          # Capacity probe + policy
├── mcp-server.mjs       # MCP stdio server
├── package.json
├── browser/
│   ├── index.html       # Interactive UI
│   └── app.js
├── tests/
│   └── core.test.mjs
├── examples/
│   └── compile-loop.mjs
└── docs/
    ├── ARCHITECTURE.md
    └── MCP.md
```

## Design rules

1. **Go/no-go is deterministic** — no stochastic compliance.  
2. **Independent proofs compound** — one path may die; others keep the conclusion.  
3. **Compile toward cheaper edges** — heavy CoT is discovery, not the steady state.  
4. **State is the contract** — download/upload JSON; any host can reimplement tools.  
5. **Harness sets intensity only** — same schema on a phone and a workstation.

## License

MIT — use, fork, wire to sensors, small models, or idle schedulers.
