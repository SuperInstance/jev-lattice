# Cloudflare deployment

```
Request ──▶ Worker (worker/index.mjs)
             ├─ /browser/*, /jev-core.js  → Static Assets (worker/public, built by scripts/build-assets.mjs)
             ├─ /health                    → open
             ├─ /admin/keys                → root key only → D1 (CONTROL)
             ├─ /mcp/:lattice              → auth → lattice access → rate limit → LatticeDO.rpc(msg, principal)
             └─ /api/:lattice/*            → auth → lattice access → rate limit → scope check → LatticeDO

LatticeDO (SQLite-backed Durable Object, one per lattice name)
  memory:  JEVLattice + MCP dispatcher, rebuilt from the lattice's settings (enabled providers)
  per call: scope (read ⊂ verify ⊂ admin), tool profile, quotas → audit row with the verdicts it moved
  storage: meta, node:<id> (diff-written), cache:<key> (Jev answers), settings, auto_verify_state,
           last_idle_cycle, SQL table `audit`
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
| GET | `/api/:lattice/audit?limit=50&node=<id>` | newest-first audit rows: `{at, actor, tool, ok, new_proofs, changes: [{id, text, from, to, margin, proofs}]}` |
| GET / PUT | `/api/:lattice/settings` | `{providers, profile, max_nodes, max_proofs_per_node, max_proofs}`; PUT merges a patch |
| POST | `/admin/keys` | `{tenant, scopes?, lattices?, profile?, label?}` → 201 with the key (shown once) |
| GET | `/admin/keys` | all keys without secrets |
| DELETE | `/admin/keys/:id` | revoke |

## Auth, scopes and tenants

Every `/mcp`, `/api` and `/admin` request needs `Authorization: Bearer <key>`. It fails closed: no key, an unknown key, or a revoked key → 401.

- **Root key**: the `JEV_API_KEY` secret. It has all scopes on all lattices, is exempt from rate limits, and is the only key that can call `/admin/keys`.
- **Tenant keys**: `jev_<12-char id>_<40-char secret>`, issued by `POST /admin/keys`. D1 stores only `sha256(secret)`; a lost key can't be recovered, only revoked and reissued.

| Scope | Allows | Examples |
|---|---|---|
| `read` | inspect | `jev_evaluate_go_no_go`, `jev_list_nodes`, `jev_export_state`, `jev_audit`, `GET stats/state/settings/audit` |
| `verify` (includes read) | add evidence | `jev_ingest`, `jev_add_proof`, `jev_verify_files`, `jev_invalidate_stale`, `jev_teach`, and any tool not listed as read or admin |
| `admin` (includes verify) | change the lattice wholesale or its policy | `jev_import_state`, `jev_prune`, `jev_predicate_register`, `jev_apply_learned`, `PUT settings`, auto-verify, idle |

- **Lattice access**: a key lists name patterns (`acme-*`, `shared`, `*`). The default is `<tenant>-*`, so a tenant's lattices are those named with its prefix. Any other lattice → 403.
- **Profiles**: a key may carry a tool profile (`gatekeeper`: 6 tools; `reader`), and a lattice may set a default one. `tools/list` shows only the tools a key may call; calling any other tool returns an MCP error result `forbidden: …`.

```bash
# issue a CI key that can verify, but not import or reconfigure, the acme lattices
curl -sX POST "$URL/admin/keys" -H "authorization: Bearer $ROOT" -H 'content-type: application/json' \
  -d '{"tenant":"acme","scopes":["verify"],"profile":"gatekeeper","label":"acme CI"}'
```

## Quotas and rate limits
- **Per key:** the `RATE_LIMITER` binding, 50 requests per 10 s per key, enforced per Cloudflare location. It is permissive and eventually consistent (Cloudflare documents it as not an accounting system), so treat it as abuse protection, not billing. The 60 s period under-enforced in testing (0 of 600 limited); the 10 s period limited as expected.
- **Per lattice** (settings, defaults from vars): `max_nodes` 5000, `max_proofs_per_node` 200, `max_proofs` 20 × max_nodes. Over quota: HTTP 429 / MCP error `quota: …`, recorded in the audit log as a failed call.

## Settings and providers
A lattice sends evidence only to the providers its settings allow. The default (`JEV_DEFAULT_PROVIDERS`) is `typesafe`. Enable the others per lattice:
```bash
curl -sX PUT "$URL/api/acme-prod/settings" -H "authorization: Bearer $ROOT" -H 'content-type: application/json' \
  -d '{"providers":["typesafe","workers-ai","predicates"]}'
```
Providers: `typesafe` (Jev tools), `minimax` (`jev_minimax_proof`, `jev_decompose`, paraphrase sense), `workers-ai` (`jev_edge_proof`), `predicates` (Dynamic Worker sandbox). Changing settings rebuilds the lattice's tool set immediately.

## Backups, environments and metrics
- **Backups:** a cron job (03:17 UTC) writes every lattice ever written (the D1 `lattices` registry) to R2 as `lattices/<name>/<time>.json.gz`, containing state, settings, the watched state and the audit log. Backups are kept for 30 days. Root-only routes: `POST /admin/backup`, `GET /admin/backups/:name`, `POST /admin/restore/:name {key}` (audited, as `restore`).
- **Staging:** `npm run deploy:staging` deploys `jev-lattice-staging` with its own D1, R2, rate-limit namespace and metrics dataset. Set its secrets with `--env staging`.
- **Metrics:** the Analytics Engine dataset `jev_lattice` (`jev_lattice_staging`) gets one point per API request: `blob1` route, `blob2` lattice, `blob3` tenant, `blob4` status, `blob5` tool; `double1` latency in ms, `double2` an is-5xx flag.
- **Request ids:** every `/mcp`, `/api` and `/admin` response carries `x-request-id`; a 500 response includes it in the body, and the log line has it.
- **Deep health:** `GET /admin/health` (root). **SLO report:** `scripts/metrics-report.mjs`, run hourly by the `slo` workflow.
- **Registry backfill:** `POST /admin/lattices {"names": [...]}` for lattices created before 0.9.
- **Key expiry:** `POST /admin/keys {…, "expires_in_days": 90}`. Expired keys get a 401 with `token expired`, and `GET /admin/keys` shows `last_used_at` (updated at most hourly).

## Audit log
Each mutating call (MCP or REST, plus the idle cycle and drift watches) writes one row: who (key id or `root`, `system:idle`), which tool, whether it succeeded, how many proofs it added, and every question whose verdict changed, with the proofs that changed it. Rows live in the lattice's own SQLite storage; the newest 10,000 are kept. Export them with `GET /api/:lattice/audit` (exporting to R2 is on the P1 list).

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…
npm run deploy
printf %s "$JEV_API_KEY"       | npx wrangler secret put JEV_API_KEY
printf %s "$TYPESAFE_AI_TOKEN" | npx wrangler secret put TYPESAFE_AI_TOKEN   # enables jev_verify*, jev_compile
printf %s "$MINIMAX_TOKEN"     | npx wrangler secret put MINIMAX_TOKEN       # enables jev_minimax_proof, jev_decompose
node scripts/smoke-worker.mjs https://jev-lattice.<subdomain>.workers.dev "$JEV_API_KEY" --live
```

One-time setup for the control plane: `npx wrangler d1 create jev-control` and put its id in `wrangler.jsonc` (`d1_databases`). The table is created on first use. Without the `CONTROL` binding, only the root key works and `/admin/keys` returns 501.

Vars in `wrangler.jsonc`: `JEV_MODEL` (pinned: `jev-1.13.0`), `JEV_DEFAULT_PROVIDERS` (`typesafe`), `JEV_MAX_NODES`, `JEV_MAX_PROOFS_PER_NODE`. Optional: `JEV_CACHE_TTL_MS` (default 24h), `MINIMAX_MODEL` (default `MiniMax-M3.1-Flash-Preview`; `MiniMax-M3` is the big-thinking model) and `WORKERS_AI_MODEL` (default `@cf/meta/llama-3.1-8b-instruct-fast`).

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

## Durable Object storage layout
| key prefix | contents | written by |
|---|---|---|
| `meta` | lattice metadata (schema, version, timestamps) | every mutation |
| `node:<id>` | one node per key, diff-written | every mutation |
| `cache:<provider\|model\|state_hash\|question_hash>` | Jev answers (+ `spread` after a stability probe) | `cachedJev` |
| `pred:<question_hash>` | registered predicate code, version, hash | `jev_predicate_register` |
| `sense:label:<question_hash>:<sense>` | (p, teacher verdict) samples, last 400 | `jev_teach` |
| `sense:para:<question_hash>` | cached MiniMax paraphrase | the `jev-paraphrase` sense |
| `auto_verify_state`, `last_idle_cycle` | the watched state; the last alarm's result | auto-verify, alarm |
| `settings` | providers, default profile, quotas | `PUT /api/:lattice/settings` |
| SQL table `audit` | one row per mutating call | every mutating call |

## Operations
- **Auth:** give every client its own tenant key, and keep the root key for administration. Revoke a key with `DELETE /admin/keys/:id`; the change applies to the next request. Rotating `JEV_API_KEY` (`wrangler secret put`) affects only root. `/health` and static assets stay public.
- **Model upgrades:** change `JEV_MODEL` deliberately. The proof cache key includes the model, so new answers are fetched; expect a few percent of verdicts to move (R5-E), mostly OPEN↔REFUTED.
- **Cost controls:**
  - The proof cache (24h TTL) and per-file channels are the big levers.
  - The idle cycle runs at most once per 10 minutes of quiet per lattice.
  - Teaching costs one call per sense per decided question.
- **Inspect a lattice:** `GET /api/<name>/stats` returns stats, the tool list, the last idle cycle and cache stats. `GET /api/<name>/state` returns the full export.
- **Reset a lattice:** `PUT /api/<name>/state` with `{"nodes": []}`. Cache, bank and predicates stay; a new lattice name gives a clean slate.
- **Roll back a deploy:** `npx wrangler rollback` (Durable Object state is unaffected), or redeploy a previous commit.
- **Logs:** observability is enabled in `wrangler.jsonc`; use `npx wrangler tail` for live logs.
- **Smoke test after every deploy:** `node scripts/smoke-worker.mjs <url> <key> --live`. It covers auth, settings, MCP, the cache, drift, predicates, Workers AI, tenant keys and scopes, profiles, quotas, the audit log, revocation and the idle cycle.
- **Beta dependency:** Dynamic Workers (`worker_loaders`) is in open beta. Without the binding, the predicate tools are simply hidden.

## Why these primitives

- **Durable Objects** give each lattice exactly one writer. The gate is deterministic *and* the state it reads is consistent, with no locks needed.
- **Alarms** are the idle/sleep phase from the architecture: consolidation and re-verification run when nobody is waiting.
- **Workers AI** gives a cheap second, independent path that runs inside Cloudflare's network (T11 in TILES.md).
- **Dynamic Workers** (Worker Loader) run model-written predicates in their own isolates. `eval` and `new Function` are unavailable in Workers, and `node:vm` is not a sandbox anyway.
- **Static Assets** serve the same `jev-core.js` that the Durable Object runs, so the browser and the edge share one implementation.
