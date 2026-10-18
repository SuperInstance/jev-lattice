#!/usr/bin/env node
/**
 * R6: in-call paraphrase ensembles. Batching is free (no interference, 800 questions in
 * ~250 ms), and wording moves p. So ask K paraphrases of each gate question in the SAME call:
 *   - mean / median of the K readings as the proof confidence (variance reduction)
 *   - their spread as a per-question uncertainty, with no re-asking (vs stabilityProbe's n calls)
 * Paraphrases from MiniMax Flash, written once per question. Also compares state framings.
 *   node experiments/typesafe-ensemble.mjs [--n 40] [--k 5] [--seed 41]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax } from "../providers/minimax.mjs";
import { reliability } from "../calibration.mjs";
import { makeGenerator, makeShiftedGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt("--n", 40)), K = Number(opt("--k", 5)), T = 0.9;
const jev = createJev({ model: opt("--model", "jev-1.13.0") });
const mm = createMiniMax();
const cache = new URL("./results/paraphrases.json", import.meta.url);
let paras;
if (fs.existsSync(cache)) paras = JSON.parse(fs.readFileSync(cache, "utf8"));
else {
  const { value } = await mm.json(`Rewrite each yes/no question ${K} times. Every rewrite must have EXACTLY the same meaning and the same yes/no polarity (a "yes" to the rewrite means a "yes" to the original). Keep any technical definition in parentheses. Vary wording and sentence structure only.\n${QUESTIONS.map(([q], j) => `q${j}: ${q}`).join("\n")}\nReply with JSON {"q0": ["...", ...], ...}.`, { maxTokens: 8000, temperature: 0.7 });
  paras = QUESTIONS.map((_, j) => (value[`q${j}`] || []).slice(0, K));
  fs.writeFileSync(cache, JSON.stringify(paras, null, 2));
}
console.log(`paraphrases per question: ${paras.map(p => p.length).join(",")}`);

const FR = {
  "files+rules": t => ({ files: { "redis.conf": t }, reading_rules: READING_RULES }),
  "described": t => ({ description: "A Redis server configuration file (redis.conf).", content: t, reading_rules: READING_RULES })
};
const streams = { "in-dist": Array.from({ length: N }, makeGenerator(Number(opt("--seed", 41)))), shifted: Array.from({ length: N }, makeShiftedGenerator(42)) };
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const summary = rows => {
  const m = reliability(rows), dec = rows.filter(r => r.p >= T || r.p <= 1 - T);
  return { brier: +m.brier.toFixed(4), decided: dec.length, wrong: dec.filter(r => (r.p >= T) !== r.truth).length, wrongGo: m.gate[0.9].wrongGo, open: rows.length - dec.length };
};
const out = { model: jev.model, N, K, at: new Date().toISOString(), arms: {} };
for (const [sname, cfgs] of Object.entries(streams)) for (const [fname, frame] of Object.entries(FR)) {
  const res = await Promise.all(cfgs.map(c => {
    const items = [];
    QUESTIONS.forEach(([q], j) => { items.push({ key: `q${j}`, instructions: q }); paras[j].forEach((pq, k) => items.push({ key: `q${j}_${k}`, instructions: pq })); });
    return jev.nouls(frame(c.text), items);
  }));
  const rows = [];
  res.forEach((a, i) => QUESTIONS.forEach(([, truth], j) => {
    const all = [a[`q${j}`].p, ...paras[j].map((_, k) => a[`q${j}_${k}`].p)];
    rows.push({ j, truth: truth(cfgs[i].c), single: all[0], mean: all.reduce((s, x) => s + x, 0) / all.length, median: med(all), min: Math.min(...all), max: Math.max(...all), spread: Math.max(...all) - Math.min(...all) });
  }));
  const arm = {};
  for (const agg of ["single", "mean", "median"]) arm[agg] = summary(rows.map(r => ({ p: r[agg], truth: r.truth })));
  // unanimity rule: GO only if every paraphrase ≥ T, REFUTED only if every one ≤ 1-T
  const unan = rows.map(r => ({ truth: r.truth, v: r.min >= T ? "GO" : r.max <= 1 - T ? "NO" : "OPEN" }));
  arm.unanimous = { decided: unan.filter(u => u.v !== "OPEN").length, wrong: unan.filter(u => u.v !== "OPEN" && (u.v === "GO") !== u.truth).length, wrongGo: unan.filter(u => u.v === "GO" && !u.truth).length };
  // does spread flag the single reading's errors?
  const wrongSingle = rows.filter(r => (r.single >= T || r.single <= 1 - T) && (r.single >= T) !== r.truth);
  arm.single_errors = wrongSingle.length;
  arm.single_errors_with_spread_gt_0_1 = wrongSingle.filter(r => r.spread > 0.1).length;
  arm.flagged_by_spread_gt_0_1 = rows.filter(r => r.spread > 0.1).length;
  out.arms[`${sname} | ${fname}`] = arm;
  console.log(`${sname.padEnd(8)} ${fname.padEnd(12)} single ${JSON.stringify(arm.single)}  mean ${JSON.stringify(arm.mean)}  median ${JSON.stringify(arm.median)}  unanimous ${JSON.stringify(arm.unanimous)}  singleErrors ${arm.single_errors} (spread>0.1: ${arm.single_errors_with_spread_gt_0_1}; flagged ${arm.flagged_by_spread_gt_0_1})`);
}
out.usage = { jev: jev.usage, minimax: mm.usage };
fs.writeFileSync(new URL("./results/typesafe-ensemble.json", import.meta.url), JSON.stringify(out, null, 2));
