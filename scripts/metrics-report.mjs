#!/usr/bin/env node
/**
 * Per-route traffic, latency and errors from the Worker's Analytics Engine dataset, checked
 * against the SLOs in docs/RUNBOOK.md. Exits 1 when an SLO is breached (the `slo` workflow runs
 * this on a schedule; a failed run is the alert).
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/metrics-report.mjs [--hours 24] [--dataset jev_lattice] [--json]
 *
 * SLOs (requests in the window, sampling-weighted):
 *   availability   ≥ 99.9% of requests are not 5xx
 *   latency        p95 ≤ 1000 ms on /api and /mcp (the backup / restore admin routes are excluded)
 * Windows with fewer than 20 requests are reported but never breach (too little data).
 */
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HOURS = Number(opt("--hours", 24)), DATASET = opt("--dataset", "jev_lattice");
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
if (!TOKEN || !ACCOUNT) { console.error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"); process.exit(2); }
if (!/^[a-z_][a-z0-9_]*$/i.test(DATASET) || !(HOURS > 0 && HOURS <= 2160)) { console.error("bad --dataset or --hours"); process.exit(2); }

async function sql(q) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: `${q} FORMAT JSON` });
  const text = await r.text();
  if (!r.ok) throw new Error(`Analytics Engine SQL ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).data;
}
const W = `timestamp > NOW() - INTERVAL '${HOURS}' HOUR`;
const rows = await sql(`SELECT blob1 AS route, sum(_sample_interval) AS requests, sum(double2 * _sample_interval) AS errors_5xx,
  quantileWeighted(0.5)(double1, _sample_interval) AS p50_ms, quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms
  FROM ${DATASET} WHERE ${W} GROUP BY route ORDER BY requests DESC`);
const total = rows.reduce((s, r) => s + Number(r.requests), 0);
const errors = rows.reduce((s, r) => s + Number(r.errors_5xx), 0);
const availability = total ? 1 - errors / total : 1;
const SLO_LATENCY_MS = 1000, SLO_AVAILABILITY = 0.999, MIN_REQUESTS = 20;
const breaches = [];
if (total >= MIN_REQUESTS && availability < SLO_AVAILABILITY) breaches.push(`availability ${(availability * 100).toFixed(3)}% < ${SLO_AVAILABILITY * 100}%`);
for (const r of rows) {
  const latencyRoute = (r.route === "mcp" || r.route.startsWith("api/")) && Number(r.requests) >= MIN_REQUESTS;
  if (latencyRoute && Number(r.p95_ms) > SLO_LATENCY_MS) breaches.push(`${r.route}: p95 ${Math.round(r.p95_ms)} ms > ${SLO_LATENCY_MS} ms`);
}
const report = { dataset: DATASET, hours: HOURS, requests: total, errors_5xx: errors, availability, routes: rows, breaches };
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${DATASET}, last ${HOURS} h: ${total} requests, ${errors} 5xx, availability ${(availability * 100).toFixed(3)}%`);
  console.log("route".padEnd(20) + "requests".padStart(10) + "p50 ms".padStart(9) + "p95 ms".padStart(9) + "5xx".padStart(6));
  for (const r of rows) console.log(String(r.route || "-").padEnd(20) + String(r.requests).padStart(10) + String(Math.round(r.p50_ms)).padStart(9) + String(Math.round(r.p95_ms)).padStart(9) + String(r.errors_5xx).padStart(6));
  console.log(breaches.length ? `SLO BREACHED:\n  ${breaches.join("\n  ")}` : "SLOs met");
}
process.exit(breaches.length ? 1 : 0);
