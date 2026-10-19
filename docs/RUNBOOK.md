# Runbook: operating JEV Edge (Cloudflare)

**Audience:** whoever is on call for the Worker. Every command assumes `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are exported, and `$URL` / `$ROOT` hold the deployment URL and its root key.

| Environment | Worker | Control D1 | Backups R2 | Cron (UTC) |
|---|---|---|---|---|
| production | `jev-lattice` | `jev-control` | `jev-backups` | 03:17 daily |
| staging | `jev-lattice-staging` | `jev-control-staging` | `jev-backups-staging` | 03:47 daily |

## Release
1. Merge to `main`. CI runs the tests, then deploys to **staging**, smoke-tests staging, and deploys to **production** (the `production` GitHub environment can require approval).
2. To deploy by hand: `npm run deploy:staging`, then `node scripts/smoke-worker.mjs <staging-url> <staging-root> --live`, then `npm run deploy`, then the smoke test against production.
3. npm: bump `package.json`, then run the `release` workflow (manually or by pushing a `vX.Y.Z` tag). It publishes with provenance.

## Health and signals
- `GET /health` returns `{ok, server: {version}}`. It needs no auth.
- `GET /admin/health` (root) checks D1, R2, a Durable Object and TypeSafe, with latencies. Use it after deploys and during incidents.
- **SLOs:** availability ≥ 99.9% (non-5xx) and p95 ≤ 1000 ms on `/api` and `/mcp`. Check with `node scripts/metrics-report.mjs [--hours 24] [--dataset jev_lattice_staging]`; the `slo` workflow runs it hourly and fails, which notifies you, on a breach.
- Every API response carries `x-request-id`; unhandled errors are logged as JSON `{event: "unhandled", rid, path, error}`. Find them with `npx wrangler tail [--env staging] --format json` or in the Workers observability UI.
- **Metrics:** the Analytics Engine dataset `jev_lattice` gets one point per request. Blobs are route, lattice, tenant, status and tool; doubles are latency in ms and an is-5xx flag. Query it with the SQL API, for example p95 latency by route over the last hour.
- **Per-lattice stats:** `GET /api/<name>/stats` (nodes, open gates, last idle cycle, cache hit rate). Audit trail: `GET /api/<name>/audit`.

## Incidents
| Symptom | Likely cause | Action |
|---|---|---|
| Gates stuck OPEN, verifier errors in results | TypeSafe outage or a 429 storm | Nothing breaks: gates fail closed and cached answers keep serving. Check TypeSafe's status channels and wait. Don't raise thresholds. |
| `max_tokens_exceeded` in errors | A question's `reads` is too big (32k tokens per question) | Narrow `reads`, or set long context for that client. |
| Spike of 429s for one tenant | Rate limit (50 requests / 10 s per key) or quota | Check `GET /api/<name>/settings`; raise `max_nodes` or the proof caps only after looking at why. |
| A key leaked | — | `DELETE /admin/keys/<id>` (takes effect on the next request), then issue a new key. `GET /admin/events` shows who issued keys, and when. |
| A lattice was corrupted or wiped by mistake | A bad import, or a client bug | `GET /admin/backups/<name>`, then `POST /admin/restore/<name> {"key": "<backup key>"}`. The restore is written to the audit log. Daily backups are kept for 30 days; take one now with `POST /admin/backup`. |
| A bad deploy | — | `npx wrangler rollback [--env staging]`. Durable Object state is unaffected. |
| The root key leaked | — | `printf %s "$NEW" \| npx wrangler secret put JEV_API_KEY`. Tenant keys are unaffected. |
| Verdicts moved without any file change | The model alias moved, or proofs expired by age | Production pins `JEV_MODEL`. The audit log shows the call that moved each verdict (expiry by age is attributed to the next call). |

## Capacity (measured on staging, `scripts/load-worker.mjs`)
- 20 concurrent clients, 400 mixed MCP calls: p50 about 90 ms, p99 about 0.5 s, 0 errors. One Durable Object serialises a lattice's writes.
- 20 concurrent clients after the 0.9 fixes: p50 about 60 ms, p99 under 0.5 s, 0 errors.
- A 5000-question lattice (the default `max_nodes`): import 1.25 s for a 1.2 MB body; an audited write p50 233 ms; evaluating one gate about 40 ms.
- The idle cycle at 5000 nodes went from **9.9 s to 2.2 s** in 0.9 (0.26 s locally). Nodes imported without coordinates had all collapsed onto one point.

**Registry note:** the backup job backs up the lattices in the D1 registry. A lattice is registered on its first write after 0.9, so lattices that existed before 0.9 and are never written again are not backed up. Register them with `POST /admin/lattices {"names": ["…"]}`.

## Restore drill (do this once per quarter)
```bash
curl -s -XPOST $URL/admin/backup -H "authorization: Bearer $ROOT"
curl -s $URL/admin/backups/drill -H "authorization: Bearer $ROOT"       # pick the newest key
curl -s -XPUT $URL/api/drill/state -H "authorization: Bearer $ROOT" -d '{"nodes":[]}'
curl -s -XPOST $URL/admin/restore/drill -H "authorization: Bearer $ROOT" -d '{"key":"lattices/drill/…"}'
```
The smoke test runs this drill on every deploy (backup → wipe → restore → node count matches).
