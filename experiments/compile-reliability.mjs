#!/usr/bin/env node
/**
 * R5-A: compile reliability and metamorphic acceptance as library defaults.
 *
 * R4-D found that only 40–60% of Flash candidates compiled at all, and that metamorphic
 * acceptance removed every post-shift error. Three arms, the same Jev labels and rewrites:
 *   v0.6           compilePredicate as shipped in 0.6 (no regeneration, plain acceptance)
 *   retry          + regenerate unusable output (genRetries 2, fence/arrow extraction)
 *   retry+meta     + metamorphic acceptance (rewrites from metamorphicRewrites)
 * Scored on 30 in-distribution + 30 shifted configs against generator truth.
 *
 *   node experiments/compile-reliability.mjs [--runs 2] [--out file]
 */
import vm from "node:vm";
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax } from "../providers/minimax.mjs";
import { compilePredicate, metamorphicRewrites } from "../compiled.mjs";
import { makeGenerator, makeShiftedGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt("--runs", 2));
const BASE_RULES = "later directives override earlier ones; lines starting with # are comments.";

/** node:vm is NOT a sandbox — local R&D only. */
function sandbox(src) {
  const ctx = vm.createContext(Object.create(null));
  const fn = vm.runInContext(`(${src})`, ctx, { timeout: 50 });
  if (typeof fn !== "function") throw new Error("not a function");
  ctx.__fn = fn;
  return text => { ctx.__t = text; return vm.runInContext("__fn(__t)", ctx, { timeout: 50 }) === true; };
}
const safe = (fn, t) => { try { return fn(t); } catch { return "threw"; } };

const jev = createJev();
const mm = createMiniMax();
const items = QUESTIONS.map(([q], j) => ({ key: `q${j}`, instructions: q }));
const teacher = async text => {
  const a = await jev.nouls({ "redis.conf": text, reading_rules: READING_RULES }, items);
  return items.map(it => a[it.key].p);
};
const train = Array.from({ length: 20 }, makeGenerator(101));
const t0 = Date.now();
const meta = await metamorphicRewrites({ mm, texts: train.map(t => t.text), teacher, n: 2, kind: "Redis configuration file (redis.conf)" });
console.log(`rewrites: ${meta.proposed} proposed, ${meta.rewrites.length} kept, ${meta.dropped} dropped (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const stream = [
  ...Array.from({ length: 30 }, makeGenerator(303)).map(x => ({ ...x, phase: "in-dist" })),
  ...Array.from({ length: 30 }, makeShiftedGenerator(404)).map(x => ({ ...x, phase: "shifted" }))
];
const ARMS = {
  "v0.6": { genRetries: 0 },
  retry: { genRetries: 2 },
  "retry+meta": { genRetries: 2, metamorphic: true }
};
const examples = train.slice(0, 3).map(t => t.text);
const results = [];
for (let run = 0; run < RUNS; run++) {
  const row = { run, arms: {} };
  await Promise.all(Object.entries(ARMS).map(async ([arm, cfg]) => {
    const outs = await Promise.all(QUESTIONS.map(async ([q], j) => {
      const r = await compilePredicate({
        mm, question: q, rules: BASE_RULES, examples, sandbox, maxAttempts: 2, genRetries: cfg.genRetries,
        labeled: train.map((t, i) => ({ text: t.text, p: meta.labels[i][j] })),
        metamorphic: cfg.metamorphic ? meta.forQuestion(j) : null
      }).catch(e => ({ accepted: false, error: e.message }));
      return r;
    }));
    const score = { "in-dist": { n: 0, wrongGo: 0, wrongNo: 0 }, shifted: { n: 0, wrongGo: 0, wrongNo: 0 } };
    for (const cfg of stream) outs.forEach((r, j) => {
      if (!r.accepted) return;
      const got = safe(r.fn, cfg.text), truth = QUESTIONS[j][1](cfg.c), s = score[cfg.phase];
      s.n++;
      if (got === true && !truth) s.wrongGo++;
      if (got !== true && truth) s.wrongNo++;
    });
    row.arms[arm] = {
      produced_code: outs.filter(r => r.code).length,
      accepted: outs.filter(r => r.accepted).length,
      generations: outs.reduce((a, r) => a + (r.generations || 0), 0),
      rejected_by_metamorphic: outs.filter(r => !r.accepted && r.disagreements === 0 && r.metamorphic_disagreements > 0).length,
      ...score
    };
  }));
  results.push(row);
  console.log(`\nrun ${run}`);
  for (const [arm, a] of Object.entries(row.arms)) {
    console.log(`  ${arm.padEnd(11)} code ${a.produced_code}/10 accepted ${a.accepted}/10 gens ${a.generations} metaRejected ${a.rejected_by_metamorphic}  in-dist wGO ${a["in-dist"].wrongGo} wNO ${a["in-dist"].wrongNo} (n=${a["in-dist"].n})  shifted wGO ${a.shifted.wrongGo} wNO ${a.shifted.wrongNo} (n=${a.shifted.n})`);
  }
}
console.log(`\nusage: jev ${JSON.stringify(jev.usage)} minimax ${JSON.stringify(mm.usage)}`);
const out = opt("--out", new URL("./results/compile-reliability.json", import.meta.url));
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), RUNS, rewrites: { proposed: meta.proposed, kept: meta.rewrites.length, dropped: meta.dropped }, results }, null, 2));
