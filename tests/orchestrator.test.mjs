/**
 * Orchestrator tests with fake providers — offline and deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JEVLattice } from "../jev-core.js";
import { createMcp } from "../mcp-core.mjs";
import * as orch from "../orchestrator.mjs";

/** Fake Jev: answers from a lookup of substrings → probability. */
function fakeJev(table, calls = []) {
  const pick = instr => {
    for (const [k, v] of Object.entries(table)) if (instr.includes(k)) return v;
    return 0.5;
  };
  return {
    calls,
    async noul(state, instructions) {
      calls.push({ kind: "noul", instructions });
      return { p: pick(instructions), model: "jev-fake", latency_ms: 1 };
    },
    async nouls(state, items) {
      calls.push({ kind: "nouls", n: items.length });
      const out = { _model: "jev-fake", _latency_ms: 1 };
      for (const it of items) out[it.key] = { p: pick(it.instructions) };
      return out;
    }
  };
}

function fakeMiniMax({ p = 0.6, subs = [] } = {}) {
  return {
    async json(prompt) {
      if (prompt.includes("sub-questions")) return { value: { sub_questions: subs }, raw: { model: "mm-fake" } };
      return { value: { answer: p > 0.5 ? "yes" : "no", probability_yes: p, rationale: "fake" }, raw: { model: "mm-fake" } };
    }
  };
}

const ask = (L, text, spec = { confidence_threshold: 0.9 }) => L.ingest({ text, question_spec: spec }).node;

test("verifyWithJev appends a cheap JEV_NOUL proof and closes a BINARY gate", async () => {
  const L = new JEVLattice();
  const q = ask(L, "Is TLS enabled?");
  const r = await orch.verifyWithJev(L, q.id, { jev: fakeJev({ TLS: 0.97 }), state: "tls=on" });
  assert.equal(r.gate.verdict, "GO");
  assert.equal(r.proof.source_type, "JEV_NOUL");
  assert.equal(r.proof.cost_weight, 0.05);
});

test("verifyOpenGates fans out all open questions in ONE provider call", async () => {
  const L = new JEVLattice();
  ask(L, "Is TLS enabled?");
  ask(L, "Is the port 6380?");
  const done = ask(L, "Already proven?");
  L.addProof(done.id, { source_type: "SENSOR", confidence: 0.99 });
  const jev = fakeJev({ TLS: 0.95, port: 0.02 });
  const r = await orch.verifyOpenGates(L, { jev, state: "cfg" });
  assert.equal(jev.calls.length, 1);
  assert.equal(jev.calls[0].n, 2, "closed question skipped");
  const verdicts = Object.fromEntries(r.results.map(x => [x.text, x.verdict]));
  assert.deepEqual(verdicts, { "Is TLS enabled?": "GO", "Is the port 6380?": "REFUTED" });
});

test("latticeState feeds observations and verified neighbours to the verifier", () => {
  const L = new JEVLattice();
  L.ingest({ text: "redis config sets tls port 6380", tags: ["redis"] });
  const q = L.ingest({ text: "redis tls port correct?", tags: ["redis"], question_spec: {} }).node;
  const st = orch.latticeState(L, q.id);
  assert.equal(st.question, q.text);
  assert.ok(st.known_facts.some(f => f.includes("6380")));
});

test("compile: Jev decides → no MiniMax call", async () => {
  const L = new JEVLattice();
  const q = ask(L, "Is TLS enabled?");
  let mmCalled = false;
  const mm = { async json() { mmCalled = true; throw new Error("should not run"); } };
  const r = await orch.compile(L, q.id, { jev: fakeJev({ TLS: 0.99 }), mm, state: "x" });
  assert.equal(r.gate.verdict, "GO");
  assert.equal(mmCalled, false);
  assert.deepEqual(r.trace.map(t => t.step), ["jev_noul"]);
});

test("compile: ambiguous → CoT → decompose → fan-out → roll-up GO", async () => {
  const L = new JEVLattice();
  const q = ask(L, "Is the cache production ready?", {
    evaluation_mode: "COORDINATED", required_independent_proofs: 2, confidence_threshold: 0.85
  });
  const jev = fakeJev({ "production ready": 0.6, "TLS": 0.95, "eviction": 0.93, "monitored": 0.9 });
  const mm = fakeMiniMax({ p: 0.7, subs: ["Is TLS on?", "Is an eviction policy set?", "Is it monitored?"] });
  const r = await orch.compile(L, q.id, { jev, mm, state: "cfg" });
  assert.deepEqual(r.trace.map(t => t.step), ["jev_noul", "minimax_cot", "decompose", "jev_fan_out", "rollup"]);
  // roll-up adds one LATTICE_READ path; parent still needs a 2nd independent ≥0.85 path
  assert.equal(r.gate.validProofs, 1);
  assert.equal(r.gate.verdict, "OPEN");
  L.addProof(q.id, { source_type: "SENSOR", confidence: 0.9 });
  assert.equal(L.evaluateGoNoGo(q.id).verdict, "GO");
  assert.equal(L.getNode(q.id).hierarchical_links.child_nodes.length, 3);
});

test("rollup: a refuted child refutes the parent; re-rollup supersedes", () => {
  const L = new JEVLattice();
  const parent = ask(L, "parent");
  const a = ask(L, "child a");
  const b = ask(L, "child b");
  for (const c of [a, b]) {
    c.hierarchical_links.parent_node = parent.id;
    parent.hierarchical_links.child_nodes.push(c.id);
  }
  L.addProof(a.id, { source_type: "SENSOR", confidence: 0.99 });
  L.addProof(b.id, { source_type: "SENSOR", confidence: 0.01 });
  assert.equal(orch.rollup(L, parent.id).gate.verdict, "REFUTED");
  L.invalidateProof(b.id, L.getNode(b.id).active_proofs[0].proof_id);
  L.addProof(b.id, { source_type: "SENSOR", provider: "v2", confidence: 0.95 });
  const r = orch.rollup(L, parent.id);
  assert.equal(r.gate.verdict, "GO");
  assert.equal(r.confidence, 0.95, "weakest child");
});

test("MCP core exposes provider tools only when providers exist and dispatches them", async () => {
  const L = new JEVLattice();
  const offline = createMcp({ lattice: L });
  assert.ok(!offline.defs.some(d => d.name === "jev_verify"));
  let persisted = 0;
  const mcp = createMcp({ lattice: L, jev: fakeJev({ TLS: 0.99 }), persist: () => { persisted++; } });
  assert.ok(mcp.defs.some(d => d.name === "jev_verify"));
  assert.ok(mcp.defs.some(d => d.name === "jev_compile"));
  assert.ok(!mcp.defs.some(d => d.name === "jev_decompose"), "no MiniMax → no decompose");
  const q = ask(L, "Is TLS enabled?");
  const res = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verify", arguments: { id: q.id, state: "tls=1" } } });
  assert.equal(res.result.isError, false);
  assert.equal(res.result.structuredContent.gate.verdict, "GO");
  assert.equal(persisted, 1);
  const err = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_verify", arguments: { id: "missing" } } });
  assert.equal(err.result.isError, true);
  assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});
