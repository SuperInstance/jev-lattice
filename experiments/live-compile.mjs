#!/usr/bin/env node
/**
 * Live progressive compilation against real providers.
 *   TYPESAFE_AI_TOKEN=… MINIMAX_TOKEN=… node experiments/live-compile.mjs
 *
 * Three questions over one config "state":
 *   - one Jev settles directly                      (cheap path)
 *   - one Jev refutes                               (cheap path, NO-GO)
 *   - one broad question that needs decomposition   (CoT → sub-questions → fan-out → roll-up)
 * Then the config changes, the stale proofs are invalidated, and one fan-out re-verifies.
 */
import { JEVLattice } from "../jev-core.js";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, MINIMAX_FAST_MODEL } from "../providers/minimax.mjs";
import * as orch from "../orchestrator.mjs";

const jev = createJev();
const mm = createMiniMax({ model: process.env.MINIMAX_MODEL || MINIMAX_FAST_MODEL });
const L = new JEVLattice();

let config = {
  "redis.conf": "port 0\ntls-port 6380\ntls-cert-file /etc/redis/tls/redis.crt\ntls-key-file /etc/redis/tls/redis.key\nmaxmemory 2gb\nmaxmemory-policy allkeys-lru\nrequirepass ${REDIS_PASSWORD}",
  "docker-compose.yml": "services:\n  redis:\n    image: redis:7.2\n    ports: ['6380:6380']\n    healthcheck:\n      test: ['CMD', 'redis-cli', '--tls', '-p', '6380', 'ping']",
  "alerts.yml": "- alert: RedisDown\n  expr: redis_up == 0\n  for: 1m"
};

const q1 = L.ingest({ text: "Does Redis only accept TLS connections (plaintext port disabled)?", question_spec: { confidence_threshold: 0.9 } }).node;
const q2 = L.ingest({ text: "Is Redis persistence (RDB or AOF) explicitly enabled?", question_spec: { confidence_threshold: 0.9 } }).node;
const q3 = L.ingest({
  text: "Is this Redis deployment production-ready?",
  question_spec: { evaluation_mode: "COORDINATED", required_independent_proofs: 2, confidence_threshold: 0.85 }
}).node;

const show = (label, r) => {
  console.log(`\n### ${label}`);
  for (const t of r.trace) console.log("  ", JSON.stringify(t).slice(0, 400));
  console.log("   gate:", r.gate.verdict, "-", r.gate.reason);
};

const t0 = Date.now();
for (const [label, q] of [["Q1 TLS-only", q1], ["Q2 persistence", q2]]) {
  show(label, await orch.compile(L, q.id, { jev, mm, state: config }));
}
// diagnostic mode: keep digging after a refutation to learn which sub-condition fails
show("Q3 production-ready (diagnostic)", await orch.compile(L, q3.id, { jev, mm, state: config, stopOn: ["GO"] }));

console.log("\n### config drift: tls disabled, plaintext port opened");
config = { ...config, "redis.conf": config["redis.conf"].replace("port 0", "port 6379").replace(/tls-.*\n/g, "") };
let invalidated = 0;
for (const n of L.listNodes()) {
  for (const p of n.active_proofs || []) {
    if (!p.invalidated && ["JEV_NOUL", "LLM_CHAIN_OF_THOUGHT", "LATTICE_READ"].includes(p.source_type)) {
      L.invalidateProof(n.id, p.proof_id, "redis.conf changed");
      invalidated++;
    }
  }
}
const re = await orch.verifyOpenGates(L, { jev, state: config });
console.log(`   invalidated ${invalidated} proofs; re-verified ${re.verified} open gates in ONE Jev call (${re.latency_ms} ms)`);
for (const r of re.results) console.log(`   ${r.verdict.padEnd(8)} p=${r.p}  ${r.text}`);
const ru = orch.rollup(L, q3.id);
console.log("   Q3 after roll-up:", ru.gate?.verdict, ru.note || ru.reason);

console.log("\n### cost");
console.log("   jev:", JSON.stringify(jev.usage));
console.log("   minimax:", JSON.stringify(mm.usage));
console.log("   wall:", Date.now() - t0, "ms; lattice:", JSON.stringify(L.stats()));
