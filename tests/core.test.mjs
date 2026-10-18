/**
 * JEV Lattice core tests — run with: node tests/core.test.mjs
 */
import { JEVLattice, createToolRegistry, SCHEMA, multiProofSalience } from "../jev-core.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  PASS", msg);
  } else {
    failed++;
    console.error("  FAIL", msg);
  }
}

function section(name) {
  console.log("\n== " + name + " ==");
}

// --- Schema & empty lattice ---
section("empty lattice");
{
  const L = new JEVLattice();
  assert(L.listNodes().length === 0, "starts empty");
  assert(L.stats().nodes === 0, "stats nodes 0");
  assert(SCHEMA.startsWith("jev-lattice/"), "schema id");
}

// --- Observation ingest ---
section("observation ingest");
{
  const L = new JEVLattice();
  const r = L.ingest({ text: "Redis on 6379", tags: ["caching"] });
  assert(r.ok === true, "ingest ok");
  assert(r.node.node_type === "OBSERVATION", "default observation");
  assert(r.node.tags.includes("caching"), "tags preserved");
  assert(L.listNodes().length === 1, "one node");
}

// --- Question + BINARY gate ---
section("BINARY question go/no-go");
{
  const L = new JEVLattice();
  const r = L.ingest({
    text: "Is port 6380 set?",
    node_type: "QUESTION",
    question_spec: {
      evaluation_mode: "BINARY",
      required_independent_proofs: 1,
      confidence_threshold: 0.9
    }
  });
  assert(r.ok && r.node.node_type === "QUESTION", "question created");
  let gate = L.evaluateGoNoGo(r.node.id);
  assert(gate.ok && gate.open === true && gate.go === false, "open without proofs");

  L.addProof(r.node.id, {
    source_type: "DETERMINISTIC_PARSER",
    confidence: 0.99,
    cost_weight: 0.01
  });
  gate = L.evaluateGoNoGo(r.node.id);
  assert(gate.go === true && gate.open === false, "GO after strong proof");
  assert(gate.mode === "BINARY", "mode BINARY");
}

// --- COORDINATED requires k proofs ---
section("COORDINATED multi-proof");
{
  const L = new JEVLattice();
  const r = L.ingest({
    text: "Caching production ready?",
    node_type: "QUESTION",
    question_spec: {
      evaluation_mode: "COORDINATED",
      required_independent_proofs: 2,
      confidence_threshold: 0.88
    },
    proof: {
      source_type: "LLM_CHAIN_OF_THOUGHT",
      confidence: 0.91,
      cost_weight: 0.85
    }
  });
  let gate = L.evaluateGoNoGo(r.node.id);
  assert(gate.go === false && gate.validProofs === 1, "one proof insufficient");

  L.addProof(r.node.id, {
    source_type: "DETERMINISTIC_PARSER",
    confidence: 0.97,
    cost_weight: 0.02
  });
  gate = L.evaluateGoNoGo(r.node.id);
  assert(gate.go === true && gate.validProofs === 2, "two proofs → GO");
  assert(gate.multiProofSalience > 0.9, "multi-proof salience high");
}

// --- multiProofSalience formula ---
section("multiProofSalience");
{
  const s0 = multiProofSalience([]);
  assert(s0 === 0, "empty → 0");
  const s1 = multiProofSalience([{ confidence: 0.9 }]);
  assert(Math.abs(s1 - 0.9) < 1e-9, "single 0.9");
  const s2 = multiProofSalience([{ confidence: 0.9 }, { confidence: 0.9 }]);
  // 1 - (0.1 * 0.1) = 0.99
  assert(Math.abs(s2 - 0.99) < 1e-9, "two 0.9 → 0.99");
}

// --- consolidate seeking tag ---
section("consolidate seeking_verification");
{
  const L = new JEVLattice();
  const r = L.ingest({
    text: "Need two proofs",
    node_type: "QUESTION",
    question_spec: {
      evaluation_mode: "COORDINATED",
      required_independent_proofs: 2,
      confidence_threshold: 0.85
    },
    proof: { source_type: "LLM_CHAIN_OF_THOUGHT", confidence: 0.9, cost_weight: 0.8 }
  });
  const c = L.consolidate({});
  assert(c.ok && c.seekingVerification >= 1, "seeking count");
  const n = L.getNode(r.node.id);
  assert(n.tags.includes("seeking_verification"), "tag applied");
  L.addProof(r.node.id, {
    source_type: "SENSOR",
    confidence: 0.95,
    cost_weight: 0.05
  });
  L.consolidate({});
  const n2 = L.getNode(r.node.id);
  assert(!n2.tags.includes("seeking_verification"), "tag cleared when GO");
}

// --- state round-trip ---
section("export / import");
{
  const L = new JEVLattice();
  L.ingest({ text: "A", tags: ["a"] });
  L.ingest({
    text: "Q?",
    node_type: "QUESTION",
    question_spec: {
      evaluation_mode: "BINARY",
      required_independent_proofs: 1,
      confidence_threshold: 0.8
    },
    proof: { source_type: "LATTICE_READ", confidence: 0.95, cost_weight: 0.01 }
  });
  const state = L.exportState();
  assert(state.schema === SCHEMA, "export schema");
  assert(state.nodes.length === 2, "export 2 nodes");

  const L2 = new JEVLattice();
  const imp = L2.importState(state);
  assert(imp.ok && imp.nodes === 2, "import ok");
  const q = L2.listNodes().find(n => n.node_type === "QUESTION");
  assert(q && L2.evaluateGoNoGo(q.id).go === true, "imported question still GO");
}

// --- tools registry ---
section("tool registry");
{
  const L = new JEVLattice();
  const tools = createToolRegistry(L);
  assert(typeof tools.evaluateGoNoGo === "function", "evaluateGoNoGo tool");
  assert(typeof tools.addProof === "function", "addProof tool");
  const list = tools.listTools();
  assert(list.tools.includes("evaluateGoNoGo"), "listed");
  const r = tools.ingest({ text: "tool path" });
  assert(r.ok, "tools.ingest works");
}

// --- query returns structure ---
section("query");
{
  const L = new JEVLattice();
  L.ingest({ text: "caching layer redis config", tags: ["caching"] });
  L.ingest({ text: "vram allocation error", tags: ["vram"] });
  L.consolidate({});
  const q = L.query({ text: "caching", topK: 3 });
  assert(q.ok && Array.isArray(q.context), "query structure");
  assert(q.latencyMs !== undefined, "latency reported");
}

// Summary
console.log("\n============================");
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log("All tests passed.");
