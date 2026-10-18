# Cloudflare deployment

```
Request ──▶ Worker (worker/index.mjs)
             ├─ /browser/*, /jev-core.js  → Static Assets (worker/public, built by scripts/build-assets.mjs)
             ├─ /health                    → open
             ├─ /mcp/:lattice              → bearer auth → LatticeDO.rpc()      (MCP JSON-RPC)
             └─ /api/:lattice/*            → bearer auth → LatticeDO.{tool,info,setAutoVerify,runIdleCycle}

LatticeDO (SQLite-backed Durable Object, one per lattice name)
  memory:  JEVLattice + MCP dispatcher (Jev, MiniMax, Workers AI providers from env)
  storage: meta, node:<id> (diff-written), cache:<key> (Jev answers), auto_verify_state, last_idle_cycle
  isolates: compiled predicates in Worker Loader (Dynamic Workers) isolates, no outbound network
  alarm:   10 min after last write → consolidate (+ Jev re-verify if auto-verify set) + prune expired cache
```

## Routes

| Method | Path | Body / result |
|---|---|---|
| POST | `/mcp/:lattice` | MCP JSON-RPC (single or batch). Notifications → 202 |
| GET | `/api/:lattice/stats` | stats, tool list, last idle cycle |
| GET / PUT | `/api/:lattice/state` | export / import lattice JSON |
| POST | `/api/:lattice/tool/:tool` | call any MCP tool with a JSON args body |
| PUT / DELETE | `/api/:lattice/auto-verify` | watch a `state`: PUT invalidates proofs built on older content and re-verifies the reopened gates (cached); DELETE stops watching |
| POST | `/api/:lattice/idle` | run the idle cycle now |

All `/mcp` and `/api` routes need `Authorization: Bearer $JEV_API_KEY`. The Worker fails closed: if no key is configured, access is refused.

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…
npm run deploy
printf %s "$JEV_API_KEY"       | npx wrangler secret put JEV_API_KEY
printf %s "$TYPESAFE_AI_TOKEN" | npx wrangler secret put TYPESAFE_AI_TOKEN   # enables jev_verify*, jev_compile
printf %s "$MINIMAX_TOKEN"     | npx wrangler secret put MINIMAX_TOKEN       # enables jev_minimax_proof, jev_decompose
node scripts/smoke-worker.mjs https://jev-lattice.<subdomain>.workers.dev "$JEV_API_KEY" --live
```

Optional vars: `JEV_CACHE_TTL_MS` (default 24h), `MINIMAX_MODEL` (default `MiniMax-M2.7-highspeed`) and `WORKERS_AI_MODEL` (default `@cf/meta/llama-3.1-8b-instruct-fast`).

Local: put the secrets in `.dev.vars` (gitignored) and run `npm run dev`. The Workers AI binding only works remotely, so `jev_edge_proof` fails in local mode.

## MCP client config (remote)

```json
{
  "mcpServers": {
    "jev-lattice-edge": {
      "type": "http",
      "url": "https://jev-lattice.<subdomain>.workers.dev/mcp/my-project",
      "headers": { "Authorization": "Bearer <JEV_API_KEY>" }
    }
  }
}
```

## Why these primitives

- **Durable Objects** give each lattice exactly one writer. The gate is deterministic *and* the state it reads is consistent, with no locks needed.
- **Alarms** are the idle/sleep phase from the architecture: consolidation and re-verification run when nobody is waiting.
- **Workers AI** gives a cheap second, independent path that runs inside Cloudflare's network (T11 in TILES.md).
- **Dynamic Workers** (Worker Loader) run model-written predicates in their own isolates. `eval` and `new Function` are unavailable in Workers, and `node:vm` is not a sandbox anyway.
- **Static Assets** serve the same `jev-core.js` that the Durable Object runs, so the browser and the edge share one implementation.
