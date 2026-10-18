/**
 * Verify questions against files with Jev, with caching and per-file drift.
 *   TYPESAFE_AI_TOKEN=… node examples/verify-files.mjs
 * Offline (no token): runs against a stand-in verifier so the flow is visible.
 */
import { JEVLattice } from "../jev-core.js";
import { createJev } from "../providers/jev.mjs";
import { cachedJev, createProofCache } from "../proof-cache.mjs";
import { verifyFiles, invalidateChangedFiles } from "../orchestrator.mjs";

const offlineJev = {
  model: "offline",
  async nouls(state, items) {
    const text = JSON.stringify(state);
    const out = { _model: "offline-stand-in" };
    for (const it of items) out[it.key] = { p: /TLS/i.test(it.instructions) ? (text.includes("tls-port") ? 0.97 : 0.03) : 0.5 };
    return out;
  }
};
const raw = process.env.TYPESAFE_AI_TOKEN ? createJev() : offlineJev;
const jev = cachedJev(raw, createProofCache());

const lattice = new JEVLattice();
const tls = lattice.ingest({
  text: "Is TLS enabled (a tls-port is configured)?",
  question_spec: { confidence_threshold: 0.9, reads: ["redis.conf"] } // Jev sees only this file
}).node;

let files = { "redis.conf": "port 0\ntls-port 6380", "app.env": "DEBUG=false" };
await verifyFiles(lattice, { jev, files });
console.log("before:", lattice.evaluateGoNoGo(tls.id).verdict);

files = { ...files, "app.env": "DEBUG=true" }; // unrelated file changes
console.log("app.env changed → invalidated:", (await invalidateChangedFiles(lattice, { files })).invalidated);

files = { ...files, "redis.conf": "port 6379" }; // the file this question reads changes
console.log("redis.conf changed → invalidated:", (await invalidateChangedFiles(lattice, { files })).invalidated);
await verifyFiles(lattice, { jev, files });
console.log("after:", lattice.evaluateGoNoGo(tls.id).verdict);
