#!/usr/bin/env node
/**
 * Decomposition vs direct (backlog 4).
 *
 * Composite questions = AND of k atomic conditions, ground truth from code.
 *   direct      one Jev Noul on the whole composite question
 *   decomposed  MiniMax splits each composite ONCE into sub-questions (reused for
 *               every config); Jev verifies all sub-questions; deterministic roll-up
 * Per config, everything (direct composites + all sub-questions) goes to Jev in ONE call.
 *
 * Verdicts at t=0.9: GO / REFUTED / OPEN(abstain). Reports decided-rate,
 * accuracy-when-decided and wrong GOs, by k.
 *
 *   node experiments/decompose-vs-direct.mjs [--n 40]
 */
import fs from "node:fs";
import { JEVLattice } from "../jev-core.js";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, MINIMAX_FAST_MODEL } from "../providers/minimax.mjs";
import * as orch from "../orchestrator.mjs";
import { makeGenerator, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const N = args.includes("--n") ? Number(args[args.indexOf("--n") + 1]) : 40;
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const T = 0.9;

const CONDS = [
  ["TLS is enabled (a tls-port is configured)", c => c.tls],
  ["password authentication (requirepass) is configured", c => c.pass],
  ["a memory limit (maxmemory) is configured", c => c.maxmemoryMb !== null],
  ["AOF persistence is enabled (appendonly yes in effect)", c => c.aof],
  ["Redis is NOT listening on all interfaces (bind is not 0.0.0.0)", c => c.bind !== "0.0.0.0"],
  ["the eviction policy is not noeviction", c => c.policy !== "noeviction"]
];
const list = k => CONDS.slice(0, k).map(([d], i) => `(${i + 1}) ${d}`).join("; ");
const COMPOSITES = [
  ...[3, 4, 5, 6].map(k => ({
    k: `all-${k}`, need: k, of: k,
    text: `Is this Redis config production-hardened, meaning ALL of the following hold: ${list(k)}?`,
    truth: c => CONDS.slice(0, k).every(([, f]) => f(c))
  })),
  // counting composites: harder for a single direct judgement
  ...[[2, 4], [3, 6], [4, 6]].map(([m, k]) => ({
    k: `${m}-of-${k}`, need: m, of: k,
    text: `Do AT LEAST ${m} of the following ${k} conditions hold for this Redis config: ${list(k)}?`,
    truth: c => CONDS.slice(0, k).filter(([, f]) => f(c)).length >= m
  }))
];
// the decomposition must be the k listed conditions for counting roll-ups to be meaningful
const conditionQuestions = k => CONDS.slice(0, k).map(([d]) => `Is it true that ${d}?`);

const jev = createJev();
const mm = createMiniMax({ model: MINIMAX_FAST_MODEL });

// decompose each composite once — the sub-question set is reusable structure
const template = new JEVLattice();
const subs = {};
for (const comp of COMPOSITES) {
  if (comp.need !== comp.of) { subs[comp.k] = conditionQuestions(comp.of); continue; }
  const q = template.ingest({ text: comp.text, question_spec: { confidence_threshold: T }, linkToNearest: false }).node;
  const d = await orch.decompose(template, q.id, { mm, maxSub: 8 });
  subs[comp.k] = d.children.map(c => c.text);
  console.log(`${comp.k} → ${subs[comp.k].length} MiniMax sub-questions`);
}

/** m-of-k roll-up over child verdicts (AND is the m = k case, same as orch.rollup). */
function countRollup(L, parent, need) {
  const v = parent.hierarchical_links.child_nodes.map(id => L.evaluateGoNoGo(id).verdict);
  const go = v.filter(x => x === "GO").length, ref = v.filter(x => x === "REFUTED").length;
  if (go >= need) return "GO";
  if (v.length - ref < need) return "REFUTED";
  return "OPEN";
}

const configs = Array.from({ length: N }, makeGenerator(555));
const stats = Object.fromEntries(COMPOSITES.map(c => [c.k, { direct: blank(), decomposed: blank(), truthYes: 0 }]));
function blank() { return { go: 0, refuted: 0, open: 0, correct: 0, wrongGo: 0 }; }
function score(s, verdict, truth) {
  if (verdict === "GO") { s.go++; if (truth) s.correct++; else s.wrongGo++; }
  else if (verdict === "REFUTED") { s.refuted++; if (!truth) s.correct++; }
  else s.open++;
}

let calls = 0;
await Promise.all(configs.map(async cfg => {
  const L = new JEVLattice();
  const state = { "redis.conf": cfg.text, reading_rules: READING_RULES };
  const direct = {}, parents = {};
  for (const comp of COMPOSITES) {
    direct[comp.k] = L.ingest({ text: comp.text, question_spec: { confidence_threshold: T }, linkToNearest: false }).node;
    const parent = L.ingest({ text: comp.text, tags: ["decomposed"], question_spec: { confidence_threshold: T }, linkToNearest: false }).node;
    for (const sq of subs[comp.k]) {
      const child = L.ingest({ text: sq, question_spec: { confidence_threshold: T }, linkToNearest: false }).node;
      child.hierarchical_links.parent_node = parent.id;
      parent.hierarchical_links.child_nodes.push(child.id);
    }
    parents[comp.k] = parent;
  }
  // ONE Jev call: direct composites + every leaf sub-question (parents are skipped: they roll up)
  const leafIds = L.listNodes().filter(n => !n.hierarchical_links.child_nodes.length && !n.tags.includes("decomposed")).map(n => n.id);
  await orch.verifyOpenGates(L, { jev, state, ids: leafIds, limit: 256 });
  calls++;
  for (const comp of COMPOSITES) {
    const truth = comp.truth(cfg.c);
    if (truth) stats[comp.k].truthYes++;
    score(stats[comp.k].direct, L.evaluateGoNoGo(direct[comp.k].id).verdict, truth);
    if (comp.need === comp.of) {
      orch.rollup(L, parents[comp.k].id);
      score(stats[comp.k].decomposed, L.evaluateGoNoGo(parents[comp.k].id).verdict, truth);
    } else {
      score(stats[comp.k].decomposed, countRollup(L, parents[comp.k], comp.need), truth);
    }
  }
}));

console.log(`\n${N} configs, ${calls} Jev calls (one per config), t=${T}\n`);
console.log("composite  truth=yes | direct: decided  acc|decided  wrongGO | decomposed: decided  acc|decided  wrongGO");
const rows = [];
for (const comp of COMPOSITES) {
  const s = stats[comp.k];
  const f = x => {
    const dec = x.go + x.refuted;
    return { decided: +(dec / N).toFixed(3), acc: dec ? +(x.correct / dec).toFixed(3) : null, wrongGo: x.wrongGo };
  };
  const d = f(s.direct), p = f(s.decomposed);
  rows.push({ k: comp.k, truthYes: s.truthYes, direct: d, decomposed: p, subQuestions: subs[comp.k] });
  console.log(`${comp.k.padEnd(9)}  ${String(s.truthYes).padStart(9)} | ${d.decided.toFixed(3).padStart(15)}  ${String(d.acc).padStart(11)}  ${String(d.wrongGo).padStart(7)} | ${p.decided.toFixed(3).padStart(19)}  ${String(p.acc).padStart(11)}  ${String(p.wrongGo).padStart(7)}`);
}
console.log(`\nusage: jev ${JSON.stringify(jev.usage)} minimax ${JSON.stringify(mm.usage)}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), N, T, rows }, null, 2));
