// Type-level smoke test of the published declarations (npm run typecheck).
import { JEVLattice, type GateResult, type Verdict } from "jev-lattice";
import { verifyFiles } from "jev-lattice/orchestrator";
import { cachedJev, createProofCache } from "jev-lattice/proof-cache";
import { createJev, choiceToProof } from "jev-lattice/providers/jev";
import { runGate } from "jev-lattice/gate";
import { createMcp, PROFILES } from "jev-lattice/mcp";

const l = new JEVLattice();
const r = l.ingest({ text: "Is TLS on?", question_spec: { confidence_threshold: 0.9, reads: ["redis.conf"] } });
if (r.ok) {
  l.addProof(r.node.id, { source_type: "PARSER", confidence: 0.99 });
  const g: GateResult = l.evaluateGoNoGo(r.node.id);
  const v: Verdict = g.verdict;
  const m: number | null = g.margin;
  void v; void m;
}
const jev = cachedJev(createJev({ model: "jev-1.13.0" }), createProofCache({ ttlMs: 3600e3 }));
void verifyFiles(l, { jev, files: { "redis.conf": "tls-port 6380" } }).then(x => x.results.map(y => y.verdict));
void runGate({ cfg: { gates: [{ id: "t", question: "q", reads: ["a"] }] } }).then(x => x.pass);
const mcp = createMcp({ lattice: l, profile: "gatekeeper" });
void mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { allow: n => (PROFILES.reader.includes(n) ? true : "read only") });
const p = choiceToProof({ probabilities: { a: 0.9 } }, ["a"]);
void p.confidence;
import { factsForFiles } from "jev-lattice/facts";
import { frameEvidence } from "jev-lattice/orchestrator";
import { lintGates } from "jev-lattice/gate";
const facts = factsForFiles({ "r.conf": "maxmemory 1gb" }, { "r.conf": [{ name: "b", extract: "size", key: "maxmemory" }] });
void frameEvidence({ "r.conf": "x" }, { facts, quarantine: true });
void lintGates({ cfg: { gates: [{ id: "a", question: "q", reads: ["r.conf"], criteria: { true: "yes" } }], quarantine: true } });
