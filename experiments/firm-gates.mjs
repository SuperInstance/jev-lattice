#!/usr/bin/env node
/**
 * R4-A: fragility-aware gates. Does requiring corroboration for fragile verdicts make
 * gates reproducible, and what does it cost?
 *   plain  Jev Noul → gate
 *   firm   Jev Noul → gate with require_firm → firmUp: fragile ones get an independent
 *          MiniMax (Flash) proof → gate
 * Each pipeline runs TWICE on the same configs with fresh (uncached) readings; reproducibility
 * = share of gates whose verdict is identical across the two runs.
 *   node experiments/firm-gates.mjs [--configs 16] [--t 0.95]
 */
import fs from "node:fs";
import { JEVLattice } from "../jev-core.js";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax } from "../providers/minimax.mjs";
import { verifyOpenGates, firmUp, proveWithMiniMax } from "../orchestrator.mjs";
import { makeGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const CONFIGS = opt("--configs", 16), T = opt("--t", 0.95);
const jev = createJev();
const mm = createMiniMax();
const cfgs = Array.from({ length: CONFIGS }, makeGenerator(4242));

async function pipeline(firm) {
  let secondCalls = 0;
  const verdicts = await Promise.all(cfgs.map(async cfg => {
    const L = new JEVLattice();
    const ids = QUESTIONS.map(([q]) => L.ingest({ text: q, question_spec: { confidence_threshold: T, require_firm: firm }, linkToNearest: false }).node.id);
    const state = { "redis.conf": cfg.text, reading_rules: READING_RULES };
    await verifyOpenGates(L, { jev, state });
    if (firm) {
      const r = await firmUp(L, { secondPath: (lat, id) => proveWithMiniMax(lat, id, { mm, state }) });
      secondCalls += r.asked;
    }
    return ids.map((id, j) => ({ v: L.evaluateGoNoGo(id).verdict, truth: QUESTIONS[j][1](cfg.c) }));
  }));
  return { verdicts: verdicts.flat(), secondCalls };
}

const out = {};
for (const [name, firm] of [["plain", false], ["firm", true]]) {
  const a = await pipeline(firm), b = await pipeline(firm);
  const same = a.verdicts.filter((x, i) => x.v === b.verdicts[i].v).length;
  const score = run => {
    const s = { correct: 0, open: 0, wrongGo: 0, wrongRef: 0 };
    for (const x of run.verdicts) {
      if (x.v === "OPEN" || x.v === "CONFLICT") s.open++;
      else if ((x.v === "GO") === x.truth) s.correct++;
      else if (x.v === "GO") s.wrongGo++;
      else s.wrongRef++;
    }
    return s;
  };
  out[name] = { reproducible: +(same / a.verdicts.length).toFixed(3), run1: score(a), run2: score(b), secondCalls: [a.secondCalls, b.secondCalls], n: a.verdicts.length };
  console.log(`${name.padEnd(6)} reproducible ${out[name].reproducible}  run1 ${JSON.stringify(out[name].run1)}  run2 ${JSON.stringify(out[name].run2)}  second-path calls ${a.secondCalls}+${b.secondCalls} of ${a.verdicts.length}`);
}
console.log(`usage: jev ${JSON.stringify(jev.usage)} minimax ${JSON.stringify(mm.usage)}`);
if (args.includes("--out")) fs.writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify({ at: new Date().toISOString(), CONFIGS, T, out }, null, 2));
