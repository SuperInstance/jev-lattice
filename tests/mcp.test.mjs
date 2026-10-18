/**
 * End-to-end MCP stdio test: spawns mcp-server.mjs and speaks JSON-RPC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp-server.mjs");

function startServer(statePath) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, JEV_STATE_PATH: statePath, JEV_TIER: "standard", JEV_NO_PROVIDERS: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 5000);
      waiting.set(id, m => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { ...r.result, data: JSON.parse(r.result.content[0].text) };
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const raw = line => child.stdin.write(line + "\n");
  const stop = () => new Promise(r => { child.on("exit", r); child.stdin.end(); });
  return { rpc, call, notify, raw, stop, waiting };
}

test("MCP stdio: handshake, tools, gate, persistence round-trip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-"));
  const statePath = path.join(dir, "state.json");
  const s = startServer(statePath);

  const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "jev-lattice");
  const old = await s.rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(old.result.protocolVersion, "2025-06-18", "unknown version → server latest");
  s.notify("notifications/initialized"); // must not produce a response

  const list = await s.rpc("tools/list");
  const names = list.result.tools.map(t => t.name);
  for (const n of ["jev_ingest", "jev_add_proof", "jev_invalidate_proof", "jev_evaluate_go_no_go", "jev_capacity", "jev_rollup"]) {
    assert.ok(names.includes(n), `has ${n}`);
  }
  assert.ok(!names.includes("jev_verify"), "provider tools hidden when offline");

  const q = await s.call("jev_ingest", {
    text: "Is REDIS_TLS_PORT 6380?",
    question_spec: { evaluation_mode: "COORDINATED", required_independent_proofs: 2, confidence_threshold: 0.9 },
    proof: { source_type: "DETERMINISTIC_PARSER", confidence: 0.99, cost_weight: 0.01 }
  });
  const id = q.data.node.id;
  assert.equal((await s.call("jev_evaluate_go_no_go", { id })).data.verdict, "OPEN");
  await s.call("jev_add_proof", { id, proof: { source_type: "SENSOR", confidence: 0.95 } });
  assert.equal((await s.call("jev_evaluate_go_no_go", { id })).data.go, true);

  const bad = await s.call("jev_get_node", { id: "nope" });
  assert.equal(bad.isError, true, "tool-level failure flagged isError");
  const unknown = await s.rpc("tools/call", { name: "jev_nope", arguments: {} });
  assert.equal(unknown.error.code, -32602);
  const nf = await s.rpc("does/not/exist");
  assert.equal(nf.error.code, -32601);
  assert.equal((await s.rpc("ping")).result !== undefined, true);

  await s.stop();
  const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(saved.nodes.length, 1);

  // restart: state survives, gate still GO
  const s2 = startServer(statePath);
  await s2.rpc("initialize", {});
  assert.equal((await s2.call("jev_evaluate_go_no_go", { id })).data.go, true);
  await s2.stop();
});

test("MCP stdio: malformed line yields a parse error, server keeps serving", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-"));
  const s = startServer(path.join(dir, "state.json"));
  const parseErr = new Promise(r => s.waiting.set(null, r));
  s.raw("{not json");
  assert.equal((await parseErr).error.code, -32700);
  assert.ok((await s.rpc("ping")).result);
  await s.stop();
});

test("tool arguments are validated against inputSchema before dispatch", async () => {
  const { createMcp, validateArgs } = await import("../mcp-core.mjs");
  const { JEVLattice } = await import("../jev-core.js");
  const m = createMcp({ lattice: new JEVLattice() });
  const callTool = (name, args) => m.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  for (const [name, args, needle] of [
    ["jev_ingest", { text: 42 }, "arguments.text: expected string"],
    ["jev_ingest", { text: "x", question_spec: "nope" }, "arguments.question_spec: expected object"],
    ["jev_ingest", { text: "x", question_spec: { evaluation_mode: "MAYBE" } }, "must be one of BINARY, COORDINATED"],
    ["jev_add_proof", { id: "x", proof: { source_type: "S", confidence: 2 } }, "must be ≤ 1"],
    ["jev_add_proof", { id: "x" }, "arguments.proof: required"]
  ]) {
    const r = await callTool(name, args);
    assert.equal(r.result.isError, true, JSON.stringify(args));
    assert.match(r.result.structuredContent.error, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((await callTool("jev_ingest", { text: "fine", question_spec: { confidence_threshold: 0.9 } })).result.isError, false);
  assert.equal(validateArgs({ type: ["string", "object"] }, { a: 1 }), null, "union types");
});

test("profiles, per-request allow/guard and extra tools", async () => {
  const { createMcp, PROFILES } = await import("../mcp-core.mjs");
  const { JEVLattice } = await import("../jev-core.js");
  const fakeJev = { model: "f", async nouls(s, items) { const o = { _model: "f" }; for (const it of items) o[it.key] = { p: 0.99 }; return o; }, async noul() { return { p: 0.99 }; } };
  let audited = 0;
  const m = createMcp({
    lattice: new JEVLattice(), jev: fakeJev,
    extraTools: [{ def: { name: "jev_audit", description: "audit", inputSchema: { type: "object", properties: {} } }, handler: () => ({ ok: true, rows: ++audited }) }]
  });
  const list = async ctx => (await m.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx)).result.tools.map(t => t.name);
  const call = (name, args, ctx) => m.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, ctx);
  assert.deepEqual((await list({ profile: "gatekeeper" })).sort(), [...PROFILES.gatekeeper].sort());
  assert.ok((await list({})).includes("jev_audit"));
  const r = await call("jev_import_state", { state: {} }, { profile: "gatekeeper" });
  assert.match(r.result.structuredContent.error, /not in the "gatekeeper" tool profile/);
  const readOnly = { allow: n => (n === "jev_list_nodes" ? true : "needs scope verify") };
  assert.match((await call("jev_ingest", { text: "x" }, readOnly)).result.structuredContent.error, /forbidden: needs scope verify/);
  const capped = { guard: n => (n === "jev_ingest" ? "quota: max_nodes reached" : null) };
  assert.match((await call("jev_ingest", { text: "x" }, capped)).result.structuredContent.error, /quota/);
  assert.equal((await call("jev_audit", {})).result.structuredContent.rows, 1);
});
