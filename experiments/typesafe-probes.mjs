#!/usr/bin/env node
/**
 * R6 probes:
 *   order      Choice option order: same question, options in original vs reversed vs shuffled order
 *   blind      evidence ablation: each gate question asked about an EMPTY file of the same name;
 *              a confident answer with no evidence comes from priors (a gate-lint signal)
 *   rot        irrelevant context: redis questions with 0 vs 3 unrelated files in the state
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { makeGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";
import { makeRepoGenerator, REPO_QUESTIONS, REPO_RULES } from "./repo-gen.mjs";

const T = 0.9;
const jev = createJev({ model: process.argv[2] || "jev-1.13.0" });
const out = { model: jev.model, at: new Date().toISOString() };
const gen = makeGenerator(201), cfgs = Array.from({ length: 30 }, gen);
const st = t => ({ files: { "redis.conf": t }, reading_rules: READING_RULES });

// order
const CH = {
  bind: { instructions: "Which address is Redis bound to?", criteria: { loopback: "127.0.0.1", all: "0.0.0.0", private: "a specific private address such as 10.x.x.x", none: "no bind directive" } },
  policy: { instructions: "Which maxmemory-policy is in effect?", criteria: { noeviction: null, "allkeys-lru": null, "volatile-lru": null, "allkeys-lfu": null, unset: "no policy set" } },
  aof: { instructions: "What is the effective appendonly setting?", criteria: { yes: "appendonly yes", no: "appendonly no or not set" } }
};
const reorder = (c, how, i) => { const e = Object.entries(c); if (how === "reversed") e.reverse(); if (how === "shuffled") e.sort((a, b) => ((a[0].length * 7 + i) % 5) - ((b[0].length * 7 + i) % 5)); return Object.fromEntries(e); };
const res = {};
for (const how of ["original", "reversed", "shuffled"]) res[how] = await Promise.all(cfgs.map((c, i) => jev.ask(st(c.text), Object.fromEntries(Object.entries(CH).map(([k, q]) => [k, { type: "choice", instructions: q.instructions, criteria: reorder(q.criteria, how, i) }])))));
const flips = {}, maxdp = {};
for (const k of Object.keys(CH)) {
  flips[k] = { reversed: 0, shuffled: 0 }; maxdp[k] = 0;
  cfgs.forEach((_, i) => { for (const how of ["reversed", "shuffled"]) { const a = res.original[i].answers[k], b = res[how][i].answers[k]; if (a.choice !== b.choice) flips[k][how]++; for (const o of Object.keys(a.probabilities)) maxdp[k] = Math.max(maxdp[k], Math.abs(a.probabilities[o] - b.probabilities[o])); } });
}
out.order = { n: cfgs.length, argmax_flips: flips, max_abs_dp: Object.fromEntries(Object.entries(maxdp).map(([k, v]) => [k, +v.toFixed(3)])) };
console.log("order", JSON.stringify(out.order));

// blind
const blindQs = [...QUESTIONS.map(([q]) => ["redis.conf", q, READING_RULES]), ...REPO_QUESTIONS.map(([f, q]) => [f, q, REPO_RULES])];
const blind = await Promise.all(blindQs.map(([f, q, rules]) => jev.noul({ files: { [f]: "" }, reading_rules: rules }, q).then(r => ({ f, q, p: r.p }))));
out.blind = blind.map(b => ({ ...b, verdict_with_no_evidence: b.p >= T ? "GO" : b.p <= 1 - T ? "REFUTED" : "OPEN" }));
console.log("blind (empty file):"); for (const b of out.blind) console.log(`  ${b.verdict_with_no_evidence.padEnd(8)} p=${b.p}  ${b.f}: ${b.q}`);

// rot
const rg = makeRepoGenerator(202);
const decoys = Array.from({ length: 30 }, () => rg.genRepo());
const rot = {};
for (const arm of ["redis only", "+3 unrelated files"]) {
  const NOTES = "# Ops notes\nWe plan to enable TLS and a password next quarter. The old cluster had maxmemory 8gb and appendonly yes.";
  const items = QUESTIONS.map(([q], j) => ({ key: `q${j}`, instructions: q }));
  const stateFor = (c, i) => arm === "redis only" ? st(c.text)
    : { files: { "redis.conf": c.text, "nginx.conf": decoys[i]["nginx.conf"].text, "app.env": decoys[i]["app.env"].text, "notes.md": NOTES }, reading_rules: READING_RULES };
  const ans = await Promise.all(cfgs.map((c, i) => jev.nouls(stateFor(c, i), items)));
  let correct = 0, wrong = 0, open = 0, brier = 0;
  ans.forEach((a, i) => QUESTIONS.forEach(([, f], j) => { const p = a[`q${j}`].p, t = f(cfgs[i].c); brier += (p - (t ? 1 : 0)) ** 2; if (p >= T || p <= 1 - T) ((p >= T) === t ? correct++ : wrong++); else open++; }));
  rot[arm] = { correct, wrong, open, brier: +(brier / 300).toFixed(4) };
}
out.rot = rot;
console.log("rot", JSON.stringify(rot));
fs.writeFileSync(new URL(`./results/typesafe-probes-${jev.model}.json`, import.meta.url), JSON.stringify(out, null, 2));
