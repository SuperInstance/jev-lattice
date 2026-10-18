/**
 * README quickstart, runnable offline: node examples/quickstart.mjs
 * (kept in sync with README.md by tests/examples.test.mjs)
 */
import { JEVLattice } from "../jev-core.js";

const lattice = new JEVLattice();

// 1. A question with an explicit contract: two independent proofs, each ≥ 0.9
const { node } = lattice.ingest({
  text: "Is the cache safe to deploy?",
  question_spec: { evaluation_mode: "COORDINATED", required_independent_proofs: 2, confidence_threshold: 0.9 }
});

// 2. Evidence arrives from different verification paths
lattice.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", provider: "redis-conf", confidence: 0.99 });
console.log(lattice.evaluateGoNoGo(node.id).verdict); // OPEN — 1 of 2 paths

lattice.addProof(node.id, { source_type: "JEV_NOUL", provider: "typesafe", confidence: 0.95 });
const gate = lattice.evaluateGoNoGo(node.id);
console.log(gate.verdict, "-", gate.reason); // GO - 2/2 independent proofs satisfied

// 3. One path's evidence changes → kill that path; the gate re-evaluates
lattice.invalidateProof(node.id, node.active_proofs[0].proof_id, "redis.conf changed");
console.log(lattice.evaluateGoNoGo(node.id).verdict); // OPEN

// 4. State is portable JSON
const copy = new JEVLattice();
copy.importState(JSON.parse(JSON.stringify(lattice.exportState())));
console.log(copy.stats().questions, "question(s) restored");
