/**
 * Proof cache + hash-targeted drift invalidation — offline with a fake Jev.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JEVLattice } from "../jev-core.js";
import * as orch from "../orchestrator.mjs";
import {
  canonicalize, stateHash, createProofCache, cachedJev, memoryStore, durableObjectStore
} from "../proof-cache.mjs";

/** Fake Jev that is deliberately NON-deterministic, like the real one. */
function noisyJev(base = 0.9) {
  const seen = { calls: 0, questions: 0, states: [] };
  let jitter = 0;
  return {
    model: "jev-latest",
    seen,
    async nouls(state, items) {
      seen.calls++;
      seen.questions += items.length;
      seen.states.push(JSON.stringify(state));
      const out = { _model: "jev-1.13.0", _latency_ms: 1, _usage: { input_tokens: 10, output_tokens: 1 } };
      for (const it of items) out[it.key] = { p: Math.min(1, base + (jitter++ % 3) * 0.04) };
      return out;
    }
  };
}

test("canonicalize sorts keys recursively, keeps array order", () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  assert.equal(canonicalize({ a: undefined, b: 2 }), '{"b":2}');
});

test("stateHash: key order is irrelevant, content is not", async () => {
  assert.equal(await stateHash({ x: 1, y: 2 }), await stateHash({ y: 2, x: 1 }));
  assert.notEqual(await stateHash({ x: 1 }), await stateHash({ x: 2 }));
  assert.notEqual(await stateHash({ x: 1, y: 2 }, { canonical: false }), await stateHash({ y: 2, x: 1 }, { canonical: false }));
});

test("cachedJev: repeat asks are served from cache and answers are reproducible", async () => {
  const jev = noisyJev();
  const cj = cachedJev(jev, createProofCache());
  const items = [{ key: "a", instructions: "Is TLS on?" }, { key: "b", instructions: "Is AOF on?" }];
  const r1 = await cj.nouls({ cfg: "x" }, items);
  const r2 = await cj.nouls({ cfg: "x" }, items);
  assert.equal(jev.seen.calls, 1, "second round never reaches the provider");
  assert.deepEqual([r2.a.p, r2.b.p], [r1.a.p, r1.b.p], "same evidence ⇒ same answer");
  assert.deepEqual(r2._cache, { hits: 2, misses: 0 });
  assert.equal(r2.a.cached, true);
});

test("cachedJev: partial hits batch only the misses into one call", async () => {
  const jev = noisyJev();
  const cj = cachedJev(jev, createProofCache());
  await cj.nouls({ cfg: "x" }, [{ key: "a", instructions: "Q1?" }]);
  const r = await cj.nouls({ cfg: "x" }, [{ key: "a", instructions: "Q1?" }, { key: "b", instructions: "Q2?" }, { key: "c", instructions: "Q3?" }]);
  assert.equal(jev.seen.calls, 2);
  assert.equal(jev.seen.questions, 3, "Q1 asked once, Q2+Q3 together");
  assert.deepEqual(r._cache, { hits: 1, misses: 2 });
});

test("cachedJev: state is canonicalized before it is sent", async () => {
  const jev = noisyJev();
  const cj = cachedJev(jev, createProofCache());
  await cj.nouls({ z: 1, a: 2 }, [{ key: "q", instructions: "Q?" }]);
  assert.equal(jev.seen.states[0], '{"a":2,"z":1}');
  await cj.nouls({ a: 2, z: 1 }, [{ key: "q", instructions: "Q?" }]);
  assert.equal(jev.seen.calls, 1, "reordered keys hit the same entry");
});

test("cache key separates questions, criteria and models", async () => {
  const cache = createProofCache();
  const base = { provider: "typesafe", model: "jev-latest", state_hash: "h", instructions: "Q?" };
  const k = await cache.keyFor(base);
  assert.notEqual(k, await cache.keyFor({ ...base, instructions: "Q2?" }));
  assert.notEqual(k, await cache.keyFor({ ...base, criteria: { true: "yes" } }));
  assert.notEqual(k, await cache.keyFor({ ...base, model: "jev-preview" }));
});

test("TTL turns old entries into misses", async () => {
  let t = 1000;
  const jev = noisyJev();
  const cj = cachedJev(jev, createProofCache({ ttlMs: 500, now: () => t }));
  await cj.nouls("s", [{ key: "q", instructions: "Q?" }]);
  t += 400;
  await cj.nouls("s", [{ key: "q", instructions: "Q?" }]);
  assert.equal(jev.seen.calls, 1);
  t += 200;
  await cj.nouls("s", [{ key: "q", instructions: "Q?" }]);
  assert.equal(jev.seen.calls, 2);
  assert.equal(cj.cache.stats.expired, 1);
});

test("durableObjectStore round-trips through a storage-shaped object", async () => {
  const backing = new Map();
  const storage = {
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => backing.has(x)).map(x => [x, backing.get(x)])) : backing.get(k); },
    async put(obj) { for (const [k, v] of Object.entries(obj)) backing.set(k, v); },
    async delete(k) { backing.delete(k); }
  };
  const store = durableObjectStore(storage);
  const entries = Array.from({ length: 300 }, (_, i) => [`k${i}`, { p: i / 300 }]);
  await store.setMany(entries);
  assert.ok([...backing.keys()].every(k => k.startsWith("cache:")));
  const got = await store.getMany(entries.map(e => e[0]).concat("missing"));
  assert.equal(got.size, 300);
  assert.equal(got.get("k150").p, 0.5);
});

test("proofs record state_hash + channel; invalidateStale retires only changed evidence", async () => {
  const L = new JEVLattice();
  const jev = cachedJev(noisyJev(0.95), createProofCache());
  const ask = text => L.ingest({ text, question_spec: { confidence_threshold: 0.9 }, linkToNearest: false }).node;
  const a = ask("Is TLS on for cache A?");
  const b = ask("Is TLS on for cache B?");
  const cfgA = { "redis.conf": "tls-port 6380" }, cfgB = { "redis.conf": "tls-port 6381" };
  await orch.verifyOpenGates(L, { jev, state: cfgA, ids: [a.id], channel: "A" });
  await orch.verifyOpenGates(L, { jev, state: cfgB, ids: [b.id], channel: "B" });
  assert.equal(a.active_proofs[0].evidence.channel, "A");
  assert.equal(a.active_proofs[0].evidence.state_hash, await stateHash(cfgA));
  assert.ok(L.evaluateGoNoGo(a.id).go && L.evaluateGoNoGo(b.id).go);

  // A drifts; B does not
  const unchanged = await orch.invalidateStale(L, { state: cfgB, channel: "B" });
  assert.deepEqual([unchanged.invalidated, unchanged.kept], [0, 1]);
  const drift = await orch.invalidateStale(L, { state: { "redis.conf": "port 6379" }, channel: "A" });
  assert.equal(drift.invalidated, 1);
  assert.deepEqual(drift.reopened, [a.id]);
  assert.equal(L.evaluateGoNoGo(a.id).go, false);
  assert.equal(L.evaluateGoNoGo(b.id).go, true, "B's proof survives A's drift");
});

test("re-verify after drift: unchanged channels hit cache, changed ones are asked", async () => {
  const L = new JEVLattice();
  const raw = noisyJev(0.95);
  const jev = cachedJev(raw, createProofCache());
  const q = L.ingest({ text: "Is TLS on?", question_spec: { confidence_threshold: 0.9 } }).node;
  await orch.verifyWithJev(L, q.id, { jev, state: { c: 1 }, channel: "c" });
  await orch.invalidateStale(L, { state: { c: 2 }, channel: "c" });
  const r = await orch.verifyWithJev(L, q.id, { jev, state: { c: 2 }, channel: "c" });
  assert.equal(r.cached, false);
  // drift back to the original content: the old answer is reused, no call
  await orch.invalidateStale(L, { state: { c: 1 }, channel: "c" });
  const back = await orch.verifyWithJev(L, q.id, { jev, state: { c: 1 }, channel: "c" });
  assert.equal(back.cached, true);
  assert.equal(raw.seen.calls, 2);
});

test("per-file evidence: questions see only their files; a change retires only dependent proofs", async () => {
  const L = new JEVLattice();
  const raw = noisyJev(0.95);
  const jev = cachedJev(raw, createProofCache());
  const qa = L.ingest({ text: "Is TLS on?", question_spec: { confidence_threshold: 0.9, reads: ["redis.conf"] }, linkToNearest: false }).node;
  const qb = L.ingest({ text: "Is gzip on?", question_spec: { confidence_threshold: 0.9, reads: ["nginx.conf"] }, linkToNearest: false }).node;
  const qc = L.ingest({ text: "Do they agree?", question_spec: { confidence_threshold: 0.9 }, linkToNearest: false }).node;
  const files = { "redis.conf": "tls-port 6380", "nginx.conf": "gzip on;" };
  const r1 = await orch.verifyFiles(L, { jev, files });
  assert.equal(r1.groups, 3, "three distinct read-sets → three calls");
  assert.ok(raw.seen.states.some(s => s.includes("redis.conf") && !s.includes("nginx.conf")), "focused state");
  // nginx changes: qb and qc (reads all) are retired, qa survives
  const files2 = { ...files, "nginx.conf": "gzip off;" };
  const inv = await orch.invalidateChangedFiles(L, { files: files2 });
  assert.equal(inv.invalidated, 2);
  assert.deepEqual(inv.changedFiles, ["nginx.conf"]);
  assert.equal(L.evaluateGoNoGo(qa.id).go, true);
  assert.equal(L.evaluateGoNoGo(qb.id).open, true);
  const r2 = await orch.verifyFiles(L, { jev, files: files2 });
  assert.equal(r2.verified, 2, "only the reopened questions are asked");
  // revert nginx: per-file state for qb is back to the old bytes → cache hit
  await orch.invalidateChangedFiles(L, { files });
  const r3 = await orch.verifyFiles(L, { jev, files });
  assert.ok(r3.cacheHits >= 2);
  assert.equal(L.getNode(qc.id).question_spec.reads, null);
});

test("stabilityProbe measures spread outside the cache and annotates the entry", async () => {
  const { stabilityProbe } = await import("../proof-cache.mjs");
  const raw = noisyJev(0.9); // jitters 0.90 / 0.94 / 0.98
  const cache = createProofCache();
  const cj = cachedJev(raw, cache);
  await cj.nouls({ c: 1 }, [{ key: "q", instructions: "Q?" }]);
  const probe = await stabilityProbe(raw, { c: 1 }, [{ key: "q", instructions: "Q?" }], { n: 3, cache });
  assert.equal(probe.q.samples.length, 3);
  assert.ok(probe.q.spread > 0);
  const again = await cj.noul({ c: 1 }, "Q?");
  assert.equal(again.cached, true);
  assert.equal(again.spread, probe.q.spread, "cached answers now carry their measured noise");
});
