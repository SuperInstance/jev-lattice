#!/usr/bin/env node
/**
 * R4-C: how do teacher errors propagate into learned sense thresholds? (offline)
 * Data: experiments/results/calib-rows-{fit,eval}.json (raw p per source × case, code truth).
 * Teacher label for a fit case: oracle (truth) · real Jev (≥0.9 yes, ≤0.1 no, else abstain) ·
 * truth with uniform flips at rate ε (20 seeds each). Student thresholds are learned per source
 * with learnThreshold (with and without the earned-discount floor), then scored on the eval split.
 *   node experiments/noisy-teacher.mjs
 */
import fs from "node:fs";
import { learnThreshold } from "../senses.mjs";

const fit = JSON.parse(fs.readFileSync("experiments/results/calib-rows-fit.json", "utf8"));
const ev = JSON.parse(fs.readFileSync("experiments/results/calib-rows-eval.json", "utf8"));
const jevFit = new Map(fit.filter(r => r.source === "jev").map(r => [r.case, r.p]));
const STUDENTS = ["workers-ai", "minimax"];
const POLICIES = {
  "strict (tolerance 0)": { minSamples: 8, minGo: 3, floor: 0.9, minGoForDiscount: 30 },
  "tolerance 3%": { minSamples: 8, minGo: 3, floor: 0.9, minGoForDiscount: 30, tolerance: 0.03 },
  "tolerance 6%": { minSamples: 8, minGo: 3, floor: 0.9, minGoForDiscount: 30, tolerance: 0.06 }
};

function evaluate(src, t) {
  const rows = ev.filter(r => r.source === src);
  if (t === null) return { t, go: 0, wrongGo: 0, recall: 0 };
  const go = rows.filter(r => r.p >= t);
  return { t, go: go.length, wrongGo: go.filter(r => !r.truth).length, recall: +(go.filter(r => r.truth).length / rows.filter(r => r.truth).length).toFixed(3) };
}
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const teachers = {
  oracle: r => r.truth,
  "jev (real)": r => { const p = jevFit.get(r.case); return p >= 0.9 ? true : p <= 0.1 ? false : null; },
  ...Object.fromEntries([0.02, 0.05, 0.1, 0.2].map(e => [`flip ${e * 100}%`, r => (rnd() < e ? !r.truth : r.truth)]))
};

const report = {};
console.log("teacher            policy                    student      labelled  teacherErr  learned t   eval GO  wrongGO  recall");
for (const [tname, teacher] of Object.entries(teachers)) {
  const reps = tname.startsWith("flip") ? 20 : 1;
  for (const [pname, pol] of Object.entries(POLICIES)) {
    for (const src of STUDENTS) {
      const agg = { labelled: 0, err: 0, wrongGo: 0, go: 0, recall: 0, ts: [] };
      for (let k = 0; k < reps; k++) {
        seed = 1000 * k + 7;
        const samples = [];
        for (const r of fit.filter(x => x.source === src)) {
          const y = teacher(r);
          if (y === null) continue;
          samples.push([r.p, y]);
          if (y !== r.truth) agg.err++;
        }
        agg.labelled += samples.length;
        const { t } = learnThreshold(samples, pol);
        const e = evaluate(src, t);
        agg.wrongGo += e.wrongGo; agg.go += e.go; agg.recall += e.recall; agg.ts.push(t);
      }
      const r = { labelled: +(agg.labelled / reps).toFixed(0), teacherErr: +(agg.err / reps).toFixed(1), t: agg.ts.every(x => x === null) ? "blocked" : agg.ts.length === 1 ? agg.ts[0] : `${Math.min(...agg.ts.filter(x => x !== null))}–${Math.max(...agg.ts.filter(x => x !== null))}${agg.ts.includes(null) ? ` (${agg.ts.filter(x => x === null).length}/${reps} blocked)` : ""}`, go: +(agg.go / reps).toFixed(1), wrongGo: +(agg.wrongGo / reps).toFixed(2), recall: +(agg.recall / reps).toFixed(3) };
      (report[tname] ||= {})[`${pname} | ${src}`] = r;
      console.log(`${tname.padEnd(18)} ${pname.padEnd(25)} ${src.padEnd(11)} ${String(r.labelled).padStart(9)}  ${String(r.teacherErr).padStart(10)}  ${String(r.t).padStart(9)}  ${String(r.go).padStart(7)}  ${String(r.wrongGo).padStart(7)}  ${String(r.recall).padStart(6)}`);
    }
  }
}
fs.writeFileSync("experiments/results/noisy-teacher.json", JSON.stringify({ at: new Date().toISOString(), report }, null, 2));
