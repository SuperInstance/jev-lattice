#!/usr/bin/env node
/**
 * Smoke test a running Worker (wrangler dev or deployed).
 *   node scripts/smoke-worker.mjs http://localhost:8787 dev-key [--live]
 * --live also exercises Jev / MiniMax / Workers AI proof tools (spends credits).
 */
const [base = "http://localhost:8787", key = "dev-key"] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const live = process.argv.includes("--live");
const lattice = `smoke-${Date.now().toString(36)}`;
let failed = 0;
const check = (cond, msg, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const rpc = async (method, params, id = 1) => {
  const r = await fetch(`${base}/mcp/${lattice}`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return r.json();
};
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result?.structuredContent ?? r;
};

const health = await (await fetch(`${base}/health`)).json();
check(health.ok, "health");
check((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status === 401, "MCP rejects missing key");
check((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status === 401, "MCP rejects wrong key");
const ui = await fetch(`${base}/browser/`);
check(ui.ok && (await ui.text()).includes("JEV"), "browser UI served");
check((await fetch(`${base}/jev-core.js`)).ok, "core module served to browser");

// providers are per-lattice opt-in (default: TypeSafe only)
const set = await (await fetch(`${base}/api/${lattice}/settings`, { method: "PUT", headers: H, body: JSON.stringify({ providers: ["typesafe", "minimax", "workers-ai", "predicates"] }) })).json();
check(set.ok && set.settings.providers.length === 4, "settings: enable all providers for this lattice", `model=${set.model}`);
const badSet = await fetch(`${base}/api/${lattice}/settings`, { method: "PUT", headers: H, body: JSON.stringify({ providers: ["openai"] }) });
check(badSet.status === 400, "settings: unknown provider rejected");

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
check(init.result?.protocolVersion === "2025-06-18", "MCP initialize");
const notif = await fetch(`${base}/mcp/${lattice}`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
check(notif.status === 202, "notification → 202");
const tools = (await rpc("tools/list")).result.tools.map(t => t.name);
check(tools.includes("jev_ingest"), "tools/list", `${tools.length} tools`);

const q = await call("jev_ingest", {
  text: "Is the Redis TLS port 6380?",
  question_spec: { evaluation_mode: "COORDINATED", required_independent_proofs: 2, confidence_threshold: 0.85 },
  proof: { source_type: "DETERMINISTIC_PARSER", confidence: 0.99, cost_weight: 0.01 }
});
const id = q.node?.id;
check(!!id, "ingest question");
check((await call("jev_evaluate_go_no_go", { id })).verdict === "OPEN", "gate OPEN with 1/2 proofs");

const st = await (await fetch(`${base}/api/${lattice}/state`, { headers: H })).json();
check(st.nodes?.length === 1, "REST export state (persisted in Durable Object)");

if (live) {
  const state = { "redis.conf": "port 0\ntls-port 6380" };
  if (tools.includes("jev_verify")) {
    const v = await call("jev_verify", { id, state, channel: "redis.conf" });
    check(v.ok && v.gate?.verdict === "GO", "Jev verify closes gate at the edge", `p=${v.p}`);
    const again = await call("jev_verify", { id, state: { "tls-port": undefined, ...state }, channel: "redis.conf" });
    check(again.cached === true && again.p === v.p, "re-verify served from DO proof cache, same answer");
    const drift = await call("jev_invalidate_stale", { state: { "redis.conf": "port 6379" }, channel: "redis.conf" });
    check(drift.invalidated === 2, "drift invalidates exactly the proofs on the old evidence", `invalidated=${drift.invalidated}`);
  }
  if (tools.includes("jev_edge_proof")) {
    const q2 = await call("jev_ingest", { text: "Is plaintext Redis disabled (port 0)?", question_spec: { confidence_threshold: 0.8 } });
    const e = await call("jev_edge_proof", { id: q2.node.id, state });
    check(e.ok, "Workers AI SMALL_MODEL proof", `p=${e.p} model=${e.proof?.model}`);
  }
}

if (tools.includes("jev_predicate_register")) {
  const question = "Is TLS enabled (a tls-port is configured)?";
  const labels = [
    { text: "port 0\ntls-port 6380", expected: true },
    { text: "TLS-PORT 6380", expected: true },
    { text: "port 6379", expected: false },
    { text: "# tls-port 6380\nport 6379", expected: false },
    { text: "bind 127.0.0.1", expected: false }
  ];
  const bad = await call("jev_predicate_register", { question, code: "t => t.includes('tls-port')", labels });
  check(bad.ok === false && bad.disagreements >= 1, "edge rejects a predicate that fails its labels", `disagreements=${bad.disagreements}`);
  const evil = await call("jev_predicate_register", { question: "net?", code: "t => { fetch('https://example.com'); return true }", labels: labels.map(l => ({ ...l, expected: true })) });
  check(evil.ok === true || evil.ok === false, "isolate tolerates code that tries the network", `ok=${evil.ok}`);
  const good = await call("jev_predicate_register", { question, code: "t => t.split('\\n').some(l => /^\\s*tls-port\\s+\\d+/i.test(l))", labels });
  check(good.ok === true && good.accepted, "edge accepts a correct predicate (validated inside the isolate)", `v${good.version} ${good.validate_ms}ms`);
  const qq = await call("jev_ingest", { text: question, question_spec: { confidence_threshold: 0.85 }, linkToNearest: false });
  const yes = await call("jev_predicate_proof", { id: qq.node.id, text: "port 0\ntls-port 6380" });
  check(yes.ok && yes.answer === true && yes.gate.verdict === "OPEN", "compiled YES is a hint: cannot close a 0.85 gate alone", `${yes.latency_ms}ms`);
  const qn = await call("jev_ingest", { text: question, question_spec: { confidence_threshold: 0.85 }, linkToNearest: false });
  const no = await call("jev_predicate_proof", { id: qn.node.id, text: "port 6379" });
  check(no.ok && no.answer === false && no.gate.verdict === "REFUTED", "compiled NO refutes", `${no.latency_ms}ms`);
}

if (live && tools.includes("jev_verify")) {
  // drift detector: watch a config; change it; only proofs on the old content are retired
  const watch = `${lattice}-watch`;
  const T = (name, a) => fetch(`${base}/api/${watch}/tool/${name}`, { method: "POST", headers: H, body: JSON.stringify(a) }).then(r => r.json());
  for (const text of ["Is TLS enabled (tls-port configured)?", "Is AOF persistence enabled?"]) {
    await T("jev_ingest", { text, question_spec: { confidence_threshold: 0.9 }, linkToNearest: false });
  }
  const put = st => fetch(`${base}/api/${watch}/auto-verify`, { method: "PUT", headers: H, body: JSON.stringify(st) }).then(r => r.json());
  const v1 = await put({ "redis.conf": "tls-port 6380\nappendonly yes" });
  check(v1.verified?.verified === 2, "watch: first state verifies both gates", v1.verified?.results.map(r => r.verdict).join(","));
  const v2 = await put({ "redis.conf": "tls-port 6380\nappendonly yes" });
  check(v2.drift.invalidated === 0 && v2.verified.verified === 0, "watch: identical state → no invalidation, no Jev call");
  const v3 = await put({ "redis.conf": "port 6379\nappendonly yes" });
  check(v3.drift.invalidated === 2 && v3.verified.verified === 2, "watch: changed state → both re-verified", v3.verified.results.map(r => `${r.verdict}`).join(","));
  const v4 = await put({ "redis.conf": "tls-port 6380\nappendonly yes" });
  check(v4.verified?.cache?.hits === 2, "watch: reverting the state is served entirely from the proof cache", JSON.stringify(v4.verified?.cache));
}

// ---------- control plane: tenant keys, scopes, quotas, audit ----------
const admin = (method, path, body) => fetch(`${base}/admin/keys${path}`, { method, headers: H, body: body && JSON.stringify(body) });
const mk = await admin("POST", "", { tenant: "smoke", scopes: ["read"], lattices: [lattice], label: "smoke reader" });
const reader = await mk.json();
if (mk.status === 501) console.log("SKIP control plane (no CONTROL binding)");
else {
  check(mk.status === 201 && reader.key?.startsWith("jev_"), "admin: root issues a tenant key");
  const RH = { authorization: `Bearer ${reader.key}`, "content-type": "application/json" };
  const rtools = (await (await fetch(`${base}/mcp/${lattice}`, { method: "POST", headers: RH, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()).result?.tools.map(t => t.name) || [];
  check(rtools.includes("jev_list_nodes") && !rtools.includes("jev_ingest") && !rtools.includes("jev_import_state"), "read key sees only read tools", `${rtools.length} tools`);
  const w = await fetch(`${base}/api/${lattice}/tool/jev_ingest`, { method: "POST", headers: RH, body: JSON.stringify({ text: "x" }) });
  check(w.status === 403, "read key cannot ingest (403)");
  check((await fetch(`${base}/api/${lattice}/state`, { headers: RH })).ok, "read key can export");
  check((await fetch(`${base}/api/other-${lattice}/stats`, { headers: RH })).status === 403, "key cannot reach another lattice");
  check((await fetch(`${base}/api/${lattice}/settings`, { method: "PUT", headers: RH, body: JSON.stringify({ profile: null }) })).status === 403, "read key cannot change settings");
  check((await fetch(`${base}/admin/keys`, { headers: RH })).status === 403, "tenant key cannot manage keys");
  const listed = await (await admin("GET", "")).json();
  check(listed.keys?.some(k => k.id === reader.id) && !JSON.stringify(listed).includes(reader.key), "admin: keys listed without secrets");

  const gk = await (await admin("POST", "", { tenant: "smoke", scopes: ["verify"], lattices: [lattice], profile: "gatekeeper" })).json();
  const GH = { authorization: `Bearer ${gk.key}`, "content-type": "application/json" };
  const gtools = (await (await fetch(`${base}/mcp/${lattice}`, { method: "POST", headers: GH, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()).result?.tools.map(t => t.name) || [];
  check(gtools.length === 6 && gtools.includes("jev_verify_files"), "gatekeeper key gets the 6-tool profile", gtools.join(","));

  // quota: cap nodes at the current count, then ingest
  const n = (await (await fetch(`${base}/api/${lattice}/stats`, { headers: H })).json()).stats.nodes;
  await fetch(`${base}/api/${lattice}/settings`, { method: "PUT", headers: H, body: JSON.stringify({ max_nodes: n }) });
  const over = await fetch(`${base}/api/${lattice}/tool/jev_ingest`, { method: "POST", headers: H, body: JSON.stringify({ text: "one too many" }) });
  check(over.status === 429 && /quota/.test((await over.json()).error), "quota: max_nodes enforced", `nodes=${n}`);
  await fetch(`${base}/api/${lattice}/settings`, { method: "PUT", headers: H, body: JSON.stringify({ max_nodes: 5000 }) });

  const audit = await (await fetch(`${base}/api/${lattice}/audit?limit=200`, { headers: RH })).json();
  const moved = audit.entries?.filter(e => e.changes.length) || [];
  check(audit.ok && audit.entries.some(e => e.tool === "jev_ingest" && e.actor === "root"), "audit: mutating calls logged with actor", `${audit.entries?.length} entries`);
  check(moved.some(e => e.changes.some(c => c.id === id)), "audit: verdict changes recorded for the first question", moved.map(e => `${e.tool}:${e.changes.map(c => `${c.from}→${c.to}`).join("/")}`).slice(0, 4).join(" "));
  check(audit.entries.some(e => e.tool === "jev_ingest" && !e.ok), "audit: refused (quota) call logged as not ok");

  // rate limit (best effort: the limiter is per-location and eventually consistent)
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push(...(await Promise.all(Array.from({ length: 100 }, () => fetch(`${base}/api/${lattice}/settings`, { headers: RH }).then(r => r.status)))));
  const limited = statuses.filter(s => s === 429).length;
  console.log(`${limited ? "PASS" : "INFO"} rate limit: ${limited}/400 requests limited at 50/10s (permissive, eventually consistent)`);

  // review fixes (docs/journal/r5-control-plane-review.*)
  const wild = await (await fetch(`${base}/api/${lattice}/audit?node=${encodeURIComponent("%")}`, { headers: H })).json(); // root: the reader key may be rate-limited by now
  check(wild.ok && wild.entries.length === 0, "audit: node filter is exact (a % is not a wildcard)");
  const exact = await (await fetch(`${base}/api/${lattice}/audit?node=${id}`, { headers: H })).json();
  check(exact.entries.length > 0 && exact.entries.every(e => e.changes.some(c => c.id === id)), "audit: node filter finds that node's changes", `${exact.entries.length} entries`);
  const big = new ReadableStream({ start(c) { const chunk = new TextEncoder().encode(" ".repeat(1 << 20)); for (let i = 0; i < 5; i++) c.enqueue(chunk); c.close(); } });
  const chunked = await fetch(`${base}/api/${lattice}/tool/jev_stats`, { method: "POST", headers: H, body: big, duplex: "half" }).catch(e => ({ status: `error ${e.message}` }));
  check(chunked.status === 413, "a 5 MiB chunked body without content-length is refused (413)", `status ${chunked.status}`);
  const fresh = await (await fetch(`${base}/api/never-used-${lattice}/audit`, { headers: H })).json();
  check(fresh.ok && fresh.entries.length === 0, "audit on an unused lattice reads as empty");

  check((await admin("DELETE", `/${reader.id}`)).ok, "admin: revoke key");
  check((await fetch(`${base}/api/${lattice}/stats`, { headers: RH })).status === 401, "revoked key rejected");
  await admin("DELETE", `/${gk.id}`);
  const events = await (await fetch(`${base}/admin/events?limit=10`, { headers: H })).json();
  check(events.ok && events.events.some(e => e.action === "revoke" && e.key_id === reader.id) && events.events.some(e => e.action === "create" && e.key_id === gk.id), "admin: key create/revoke history recorded");
}

const idle = await (await fetch(`${base}/api/${lattice}/idle`, { method: "POST", headers: H })).json();
check(idle.ok && idle.consolidate?.ok, "idle cycle (alarm handler) runs");
const info = await (await fetch(`${base}/api/${lattice}/stats`, { headers: H })).json();
check(info.last_idle_cycle?.at, "idle cycle recorded");

console.log(failed ? `\n${failed} FAILED` : "\nall smoke checks passed");
process.exit(failed ? 1 : 0);
