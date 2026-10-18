#!/usr/bin/env node
/**
 * Choice / Score answers as gates (backlog 5).
 *
 * For propositions about the same field, compare:
 *   noul         one yes/no question per proposition
 *   choice→p     one Choice over the field's values; P(prop) = Σ P(allowed options)
 *   score→p      one Score over ordered levels; P(prop) = Σ P(levels ≥ L)
 * All question types for a config go in ONE mixed Jev request.
 *
 *   node experiments/choice-score-gates.mjs [--n 30]
 */
import fs from "node:fs";
import { createJev, choiceToProof, scoreToProof } from "../providers/jev.mjs";
import { reliability } from "../calibration.mjs";
import { makeGenerator, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const N = args.includes("--n") ? Number(args[args.indexOf("--n") + 1]) : 30;
const jev = createJev();

const QUESTIONS = {
  // nouls
  n_loop: { type: "noul", instructions: "Is Redis bound only to the loopback interface (bind 127.0.0.1)?" },
  n_all: { type: "noul", instructions: "Is Redis listening on all interfaces (bind 0.0.0.0)?" },
  n_evict: { type: "noul", instructions: "Does the eviction policy evict keys when memory is full (anything but noeviction)?" },
  n_lfu: { type: "noul", instructions: "Is the eviction policy an LFU policy?" },
  n_mem1g: { type: "noul", instructions: "Is the memory limit (maxmemory) at least 1 GB?" },
  n_mem4g: { type: "noul", instructions: "Is the memory limit (maxmemory) at least 4 GB?" },
  // one choice per field
  c_bind: { type: "choice", instructions: "Which address is Redis bound to?", criteria: { loopback: "127.0.0.1", all: "0.0.0.0", private: "a specific private address such as 10.x.x.x" } },
  c_policy: { type: "choice", instructions: "Which maxmemory-policy is in effect?", criteria: { noeviction: null, "allkeys-lru": null, "volatile-lru": null, "allkeys-lfu": null } },
  // one score for the ordered field
  s_mem: { type: "score", instructions: "How large is the configured memory limit (maxmemory)?", criteria: ["no limit configured", "under 1 GB", "1 GB up to (not including) 4 GB", "4 GB or more"] }
};
// proposition → [truth fn, noul key, derived reader]
const PROPS = {
  loopback: [c => c.bind === "127.0.0.1", "n_loop", a => choiceToProof(a.c_bind, ["loopback"]).confidence],
  allIfaces: [c => c.bind === "0.0.0.0", "n_all", a => choiceToProof(a.c_bind, ["all"]).confidence],
  evicts: [c => c.policy !== "noeviction", "n_evict", a => choiceToProof(a.c_policy, ["allkeys-lru", "volatile-lru", "allkeys-lfu"]).confidence],
  lfu: [c => c.policy === "allkeys-lfu", "n_lfu", a => choiceToProof(a.c_policy, ["allkeys-lfu"]).confidence],
  mem1g: [c => (c.maxmemoryMb || 0) >= 1024, "n_mem1g", a => scoreToProof(a.s_mem, 2).confidence],
  mem4g: [c => (c.maxmemoryMb || 0) >= 4096, "n_mem4g", a => scoreToProof(a.s_mem, 3).confidence]
};

const configs = Array.from({ length: N }, makeGenerator(777));
const rows = { noul: [], derived: [] };
const perProp = {};
await Promise.all(configs.map(async cfg => {
  const data = await jev.ask({ "redis.conf": cfg.text, reading_rules: READING_RULES }, QUESTIONS);
  const a = data.answers;
  for (const [name, [truthFn, nk, derive]] of Object.entries(PROPS)) {
    const truth = truthFn(cfg.c);
    const pn = a[nk].noul, pd = derive(a);
    rows.noul.push({ p: pn, truth });
    rows.derived.push({ p: pd, truth });
    (perProp[name] ||= { noul: [], derived: [] });
    perProp[name].noul.push({ p: pn, truth });
    perProp[name].derived.push({ p: pd, truth });
  }
}));

const fmt = m => `brier ${m.brier.toFixed(4)}  ECE ${m.ece.toFixed(4)}  GO@0.9 ${m.gate[0.9].go} wrong ${m.gate[0.9].wrongGo} recall ${m.gate[0.9].recall.toFixed(3)}`;
console.log(`${N} configs × ${Object.keys(PROPS).length} propositions; one mixed Jev request per config\n`);
console.log(`ALL   noul      ${fmt(reliability(rows.noul))}`);
console.log(`ALL   derived   ${fmt(reliability(rows.derived))}`);
for (const [name, r] of Object.entries(perProp)) {
  console.log(`${name.padEnd(9)} noul    ${fmt(reliability(r.noul))}`);
  console.log(`${"".padEnd(9)} derived ${fmt(reliability(r.derived))}`);
}
console.log(`\nquestions per config: noul path ${Object.keys(PROPS).length}, derived path 3 (2 choice + 1 score) — usage ${JSON.stringify(jev.usage)}`);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), N, all: { noul: reliability(rows.noul), derived: reliability(rows.derived) }, perProp: Object.fromEntries(Object.entries(perProp).map(([k, v]) => [k, { noul: reliability(v.noul), derived: reliability(v.derived) }])) }, null, 2));
