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
    const v = await call("jev_verify", { id, state });
    check(v.ok && v.gate?.verdict === "GO", "Jev verify closes gate at the edge", `p=${v.p}`);
  }
  if (tools.includes("jev_edge_proof")) {
    const q2 = await call("jev_ingest", { text: "Is plaintext Redis disabled (port 0)?", question_spec: { confidence_threshold: 0.8 } });
    const e = await call("jev_edge_proof", { id: q2.node.id, state });
    check(e.ok, "Workers AI SMALL_MODEL proof", `p=${e.p} model=${e.proof?.model}`);
  }
}

const idle = await (await fetch(`${base}/api/${lattice}/idle`, { method: "POST", headers: H })).json();
check(idle.ok && idle.consolidate?.ok, "idle cycle (alarm handler) runs");
const info = await (await fetch(`${base}/api/${lattice}/stats`, { headers: H })).json();
check(info.last_idle_cycle?.at, "idle cycle recorded");

console.log(failed ? `\n${failed} FAILED` : "\nall smoke checks passed");
process.exit(failed ? 1 : 0);
