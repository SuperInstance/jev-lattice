/**
 * Regression tests for bugs found reviewing the v0.2 drop.
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JEVLattice, createToolRegistry, normalizeProof, normalizeQuestionSpec } from "../jev-core.js";

const coordinated = (k = 2, t = 0.85) => ({
  evaluation_mode: "COORDINATED",
  required_independent_proofs: k,
  confidence_threshold: t
});

test("confidence 0 stays 0 (was coerced to 0.5)", () => {
  assert.equal(normalizeProof({ source_type: "SENSOR", confidence: 0 }).confidence, 0);
});

test("missing cost_weight defaults to 0.5, never NaN", () => {
  const p = normalizeProof({ source_type: "SENSOR", confidence: 0.9 });
  assert.equal(p.cost_weight, 0.5);
  assert.equal(normalizeProof({ cost_weight: "junk" }).cost_weight, 0.5);
});

test("threshold 0 is honoured (was coerced to 0.85)", () => {
  assert.equal(normalizeQuestionSpec({ confidence_threshold: 0 }).confidence_threshold, 0);
});

test("QUESTION without question_spec is gated NO-GO, not implicit GO", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({ text: "Is it safe?", node_type: "QUESTION" });
  const g = L.evaluateGoNoGo(node.id);
  assert.equal(g.go, false);
  assert.equal(g.gated, true);
  assert.equal(g.mode, "BINARY");
});

test("the same verification path added twice does not satisfy COORDINATED", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({ text: "Q", question_spec: coordinated(2) });
  L.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", confidence: 0.99 });
  L.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", confidence: 0.98 });
  assert.equal(L.evaluateGoNoGo(node.id).go, false);
  // a different provider of the same source type is a separate path
  L.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", provider: "yaml", confidence: 0.97 });
  assert.equal(L.evaluateGoNoGo(node.id).go, true);
});

test("explicit independence_key groups proofs across source types", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({ text: "Q", question_spec: coordinated(2) });
  L.addProof(node.id, { source_type: "SMALL_MODEL", confidence: 0.9, independence_key: "same-prompt" });
  L.addProof(node.id, { source_type: "LLM_CHAIN_OF_THOUGHT", confidence: 0.9, independence_key: "same-prompt" });
  assert.equal(L.evaluateGoNoGo(node.id).validProofs, 1);
});

test("invalidating a proof reopens the gate; other paths keep it", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({
    text: "Q",
    question_spec: coordinated(2),
    proof: { source_type: "LLM_CHAIN_OF_THOUGHT", confidence: 0.95 }
  });
  const r = L.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", confidence: 0.99 });
  L.addProof(node.id, { source_type: "SENSOR", confidence: 0.96 });
  assert.equal(L.evaluateGoNoGo(node.id).go, true);
  const inv = L.invalidateProof(node.id, r.proof.proof_id, "config changed");
  assert.equal(inv.gate.go, true, "two paths remain");
  const llm = node.active_proofs.find(p => p.source_type === "LLM_CHAIN_OF_THOUGHT");
  assert.equal(L.invalidateProof(node.id, llm.proof_id).gate.go, false);
  assert.equal(L.invalidateProof(node.id, "nope").ok, false);
});

test("max_proof_age_ms expires stale proofs deterministically", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({
    text: "Q",
    question_spec: { evaluation_mode: "BINARY", confidence_threshold: 0.9, max_proof_age_ms: 1000 },
    proof: { source_type: "SENSOR", confidence: 0.99, timestamp: "2026-01-01T00:00:00.000Z" }
  });
  const t0 = Date.parse("2026-01-01T00:00:00.500Z");
  assert.equal(L.evaluateGoNoGo(node.id, { now: t0 }).go, true);
  assert.equal(L.evaluateGoNoGo(node.id, { now: t0 + 1000 }).go, false);
});

test("allowed_sources restricts which proofs can close a gate", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({
    text: "Q",
    question_spec: { confidence_threshold: 0.8, allowed_sources: ["DETERMINISTIC_PARSER"] },
    proof: { source_type: "LLM_CHAIN_OF_THOUGHT", confidence: 0.99 }
  });
  assert.equal(L.evaluateGoNoGo(node.id).go, false);
  L.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", confidence: 0.9 });
  assert.equal(L.evaluateGoNoGo(node.id).go, true);
});

test("exportState is a deep copy — mutating it does not touch the lattice", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({ text: "A", tags: ["x"] });
  const st = L.exportState();
  st.nodes[0].tags.push("leak");
  assert.deepEqual(L.getNode(node.id).tags, ["x"]);
});

test("importState rejects non-array nodes and does not wipe the lattice", () => {
  const L = new JEVLattice();
  L.ingest({ text: "keep me" });
  assert.equal(L.importState({ nodes: "bad" }).ok, false);
  assert.equal(L.listNodes().length, 1);
});

test("consolidate merge leaves no self-loops and keeps dropped node's edges", () => {
  const L = new JEVLattice();
  const a = L.createNode({ text: "a", coords: [0, 0] });
  const b = L.createNode({ text: "b", coords: [0.01, 0] });
  const c = L.createNode({ text: "c", coords: [5, 5] });
  L._addEdge(a.id, b.id, 0.5);
  L._addEdge(b.id, c.id, 0.5);
  L.consolidate({ mergeDistance: 0.1, stitchRadius: 0.05, pruneFloor: 0 });
  const survivors = L.listNodes();
  assert.equal(survivors.length, 2);
  for (const n of survivors) {
    assert.ok(n.transition_probabilities.every(e => e.target_node_id !== n.id), "no self loop");
    assert.ok(n.transition_probabilities.every(e => L.getNode(e.target_node_id)), "no dangling edge");
  }
  const merged = survivors.find(n => n.id !== c.id);
  assert.ok(merged.transition_probabilities.some(e => e.target_node_id === c.id), "edge to c inherited");
});

test("query tolerates bad args", () => {
  const L = new JEVLattice();
  L.ingest({ text: "redis caching" });
  const q = L.query({ text: "redis", tags: "caching", topK: "x", beam: null });
  assert.equal(q.ok, true);
});

test("tool registry exposes invalidateProof", () => {
  const tools = createToolRegistry(new JEVLattice());
  assert.ok(tools.listTools().tools.includes("invalidateProof"));
});

test("import preserves invalidation + provenance", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({
    text: "Q",
    question_spec: coordinated(1),
    proof: { source_type: "JEV_NOUL", provider: "typesafe", model: "jev-1.13.0", confidence: 0.99 }
  });
  L.invalidateProof(node.id, node.active_proofs[0].proof_id, "stale");
  const L2 = new JEVLattice();
  L2.importState(L.exportState());
  const p = L2.getNode(node.id).active_proofs[0];
  assert.equal(p.invalidated, true);
  assert.equal(p.model, "jev-1.13.0");
  assert.equal(L2.evaluateGoNoGo(node.id).go, false);
});

test("a confident 'no' proof yields REFUTED, not just OPEN", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({
    text: "Is port 6380?",
    question_spec: { confidence_threshold: 0.9 },
    proof: { source_type: "JEV_NOUL", confidence: 0.01 }
  });
  const g = L.evaluateGoNoGo(node.id);
  assert.equal(g.go, false);
  assert.equal(g.verdict, "REFUTED");
});

test("conflicting paths block GO by default; opt-out allowed", () => {
  for (const block of [true, false]) {
    const L = new JEVLattice();
    const { node } = L.ingest({
      text: "Q",
      question_spec: { ...coordinated(2, 0.9), block_on_conflict: block },
      proof: { source_type: "LLM_CHAIN_OF_THOUGHT", confidence: 0.95 }
    });
    L.addProof(node.id, { source_type: "SENSOR", confidence: 0.97 });
    L.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", confidence: 0.02 });
    const g = L.evaluateGoNoGo(node.id);
    assert.equal(g.verdict, "CONFLICT");
    assert.equal(g.go, !block);
  }
});

test("boolean numerics fall back to defaults (found by MiniMax review)", () => {
  assert.equal(normalizeQuestionSpec({ confidence_threshold: false }).confidence_threshold, 0.85);
  assert.equal(normalizeProof({ cost_weight: true }).cost_weight, 0.5);
});

test("import sanitizes malformed spatial coordinates", () => {
  const L = new JEVLattice();
  L.importState({ nodes: [{ id: "a", text: "a", spatial_coordinate: [1] }, { id: "b", text: "b", spatial_coordinate: "x" }] });
  assert.deepEqual(L.getNode("a").spatial_coordinate, [1, 0]);
  assert.deepEqual(L.getNode("b").spatial_coordinate, [0, 0]);
  assert.equal(L.consolidate({}).ok, true);
});

test("re-asking the same path cannot cherry-pick: the latest reading replaces earlier ones", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({ text: "Q", question_spec: { confidence_threshold: 0.9 } });
  L.addProof(node.id, { source_type: "JEV_NOUL", provider: "typesafe", confidence: 0.93 });
  assert.equal(L.evaluateGoNoGo(node.id).verdict, "GO");
  // same verifier, same question, asked again: it now says 0.85 → the path is no longer ≥ 0.9
  L.addProof(node.id, { source_type: "JEV_NOUL", provider: "typesafe", confidence: 0.85 });
  const g = L.evaluateGoNoGo(node.id);
  assert.equal(g.verdict, "OPEN");
  assert.equal(g.paths, 1);
  assert.equal(g.bestConfidence, 0.85);
  // an independent path is still additive
  L.addProof(node.id, { source_type: "SENSOR", confidence: 0.95 });
  assert.equal(L.evaluateGoNoGo(node.id).verdict, "GO");
});

test("a path that recovers from a refutation is no longer refuting", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({ text: "Q", question_spec: { confidence_threshold: 0.9 } });
  L.addProof(node.id, { source_type: "SENSOR", confidence: 0.02 });
  assert.equal(L.evaluateGoNoGo(node.id).verdict, "REFUTED");
  L.addProof(node.id, { source_type: "SENSOR", confidence: 0.97 });
  assert.equal(L.evaluateGoNoGo(node.id).verdict, "GO", "sensor re-read supersedes, no CONFLICT with itself");
});

test("source_thresholds raise the bar for an overconfident source only", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({
    text: "Q",
    question_spec: { confidence_threshold: 0.9, source_thresholds: { SMALL_MODEL: 0.99, junk: "x" } },
    proof: { source_type: "SMALL_MODEL", provider: "workers-ai", confidence: 0.95 }
  });
  assert.deepEqual(node.question_spec.source_thresholds, { SMALL_MODEL: 0.99 });
  assert.equal(L.evaluateGoNoGo(node.id).verdict, "OPEN", "0.95 from a small model is not enough");
  L.addProof(node.id, { source_type: "JEV_NOUL", provider: "typesafe", confidence: 0.95 });
  assert.equal(L.evaluateGoNoGo(node.id).verdict, "GO", "0.95 from Jev is");
  // refutation uses the same per-source bar: 0.03 > 1 − 0.99 → not a confident "no"
  const { node: n2 } = L.ingest({
    text: "Q2",
    question_spec: { confidence_threshold: 0.9, source_thresholds: { SMALL_MODEL: 0.99 } },
    proof: { source_type: "SMALL_MODEL", confidence: 0.03 }
  });
  assert.equal(L.evaluateGoNoGo(n2.id).verdict, "OPEN");
});

test("margin + fragility: a verdict within the noise band of its bar is flagged", () => {
  const L = new JEVLattice();
  const firm = L.ingest({ text: "firm", question_spec: { confidence_threshold: 0.9 }, proof: { source_type: "JEV_NOUL", confidence: 0.97 } }).node;
  const thin = L.ingest({ text: "thin", question_spec: { confidence_threshold: 0.9 }, proof: { source_type: "JEV_NOUL", confidence: 0.91 } }).node;
  const noisy = L.ingest({ text: "noisy", question_spec: { confidence_threshold: 0.9 }, proof: { source_type: "JEV_NOUL", confidence: 0.95, evidence: { spread: 0.06 } } }).node;
  const no = L.ingest({ text: "no", question_spec: { confidence_threshold: 0.9 }, proof: { source_type: "JEV_NOUL", confidence: 0.09 } }).node;
  const g = id => L.evaluateGoNoGo(id);
  assert.deepEqual([g(firm.id).verdict, g(firm.id).margin, g(firm.id).fragile], ["GO", 0.07, false]);
  assert.deepEqual([g(thin.id).verdict, g(thin.id).fragile], ["GO", true], "0.01 above the bar, inside the 0.02 band");
  assert.equal(g(noisy.id).fragile, true, "measured spread 0.06 > margin 0.05");
  assert.deepEqual([g(no.id).verdict, g(no.id).fragile], ["REFUTED", true]);
});

test("COORDINATED margin is the weakest path still needed", () => {
  const L = new JEVLattice();
  const { node } = L.ingest({ text: "Q", question_spec: { evaluation_mode: "COORDINATED", required_independent_proofs: 2, confidence_threshold: 0.9 } });
  L.addProof(node.id, { source_type: "SENSOR", confidence: 0.99 });
  L.addProof(node.id, { source_type: "JEV_NOUL", confidence: 0.93 });
  L.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", confidence: 0.96 });
  assert.equal(L.evaluateGoNoGo(node.id).margin, 0.06, "2nd-best path (0.96) decides; 0.93 is spare");
});
