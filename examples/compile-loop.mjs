/**
 * Progressive compilation demo (no browser).
 * Run: node examples/compile-loop.mjs
 */
import { JEVLattice, createToolRegistry } from "../jev-core.js";
import { createHarness } from "../harness.mjs";

const lattice = new JEVLattice();
const tools = createToolRegistry(lattice);
const harness = createHarness();

console.log("Capacity:", JSON.stringify(harness.snapshot().capacity, null, 2));
console.log("Policy tier:", harness.policy().tier);

// Phase 1: expensive discovery path only
const q = tools.ingest({
  text: "Verify agent caching layer is production-ready",
  tags: ["caching", "verify"],
  node_type: "QUESTION",
  question_spec: {
    evaluation_mode: "COORDINATED",
    required_independent_proofs: 2,
    confidence_threshold: 0.88,
    intent: "caching production readiness"
  },
  proof: {
    source_type: "LLM_CHAIN_OF_THOUGHT",
    confidence: 0.91,
    cost_weight: 0.85,
    note: "initial heavy CoT"
  }
});

console.log("\nAfter ingest (1 expensive proof):");
console.log(tools.evaluateGoNoGo({ id: q.node.id }));

// Phase 2: independent cheap proof arrives
tools.addProof({
  id: q.node.id,
  proof: {
    source_type: "DETERMINISTIC_PARSER",
    confidence: 0.97,
    cost_weight: 0.02,
    note: "config parse"
  }
});

console.log("\nAfter cheap independent proof:");
console.log(tools.evaluateGoNoGo({ id: q.node.id }));

// Consolidate
const c = tools.consolidate({});
console.log("\nConsolidate:", c);
console.log("Stats:", tools.stats());

// Export portable state
const state = tools.exportState();
console.log("\nExported nodes:", state.nodes.length, "schema:", state.schema);
console.log("Done — lattice compiled from expensive CoT toward cheap gate.");
