#!/usr/bin/env node
/**
 * R5-C: teacher error rate → tolerance, automatically (offline).
 * Same data and teachers as R4-C (noisy-teacher.mjs). New policies:
 *   auto (ε known)      learnThreshold({ teacherErrorRate: ε }) with the true flip rate
 *   auto (ε audited)    ε estimated by auditing 30 random teacher labels against code truth
 *                       (what an operator can do: hand-check a small sample)
 * against strict (0) and the fixed tolerances R4-C had to pick by hand.
 *   node experiments/auto-tolerance.mjs
 */
import fs from "node:fs";
import { learnThreshold, teacherErrorRate } from "../senses.mjs";

const fit = JSON.parse(fs.readFileSync("experiments/results/calib-rows-fit.json", "utf8"));
const ev = JSON.parse(fs.readFileSync("experiments/results/calib-rows-eval.json", "utf8"));
const jevFit = new Map(fit.filter(r => r.source === "jev").map(r => [r.case, r.p]));
const STUDENTS = ["workers-ai", "minimax"];
const BASE = { minSamples: 8, minGo: 3, floor: 0.9, minGoForDiscount: 30 };
const AUDIT = 30, REPS = 20;

let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
function evaluate(src, t) {
  const rows = ev.filter(r => r.source === src);
  if (t === null) return { go: 0, wrongGo: 0, recall: 0 };
  const go = rows.filter(r => r.p >= t);
  return { go: go.length, wrongGo: go.filter(r => !r.truth).length, recall: go.filter(r => r.truth).length / rows.filter(r => r.truth).length };
}
const teachers = {
  oracle: { eps: 0, label: r => r.truth },
  "jev (real)": { eps: null, label: r => { const p = jevFit.get(r.case); return p >= 0.9 ? true : p <= 0.1 ? false : null; } },
  ...Object.fromEntries([0.02, 0.05, 0.1, 0.2].map(e => [`flip ${e * 100}%`, { eps: e, label: r => (rnd() < e ? !r.truth : r.truth) }]))
};

const report = {};
console.log("teacher        policy               student     ε used   wrongGO  recall  blocked");
for (const [tname, T] of Object.entries(teachers)) {
  const reps = tname.startsWith("flip") ? REPS : 1;
  for (const src of STUDENTS) {
    const agg = {};
    for (let k = 0; k < reps; k++) {
      seed = 1000 * k + 7;
      const rows = fit.filter(x => x.source === src);
      const labelled = rows.map(r => ({ r, y: T.label(r) })).filter(x => x.y !== null);
      const samples = labelled.map(({ r, y }) => [r.p, y]);
      // operator audit: hand-check AUDIT random labels against truth
      const pick = [...labelled].sort(() => rnd() - 0.5).slice(0, AUDIT);
      const audited = teacherErrorRate(pick.map(({ r, y }) => [y, r.truth]));
      const policies = {
        "strict": { ...BASE },
        "fixed 3%": { ...BASE, tolerance: 0.03 },
        "fixed 6%": { ...BASE, tolerance: 0.06 },
        ...(T.eps !== null ? { "auto (ε known)": { ...BASE, teacherErrorRate: T.eps } } : {}),
        "auto (ε audited)": { ...BASE, teacherErrorRate: audited.rate },
        "auto (ε upper95)": { ...BASE, teacherErrorRate: audited.upper95 }
      };
      for (const [pname, pol] of Object.entries(policies)) {
        const { t } = learnThreshold(samples, pol);
        const e = evaluate(src, t);
        const a = (agg[pname] ||= { wrongGo: 0, recall: 0, blocked: 0, eps: 0 });
        a.wrongGo += e.wrongGo; a.recall += e.recall; a.blocked += t === null ? 1 : 0; a.eps += pol.teacherErrorRate ?? pol.tolerance ?? 0;
      }
    }
    for (const [pname, a] of Object.entries(agg)) {
      const r = { eps: +(a.eps / reps).toFixed(3), wrongGo: +(a.wrongGo / reps).toFixed(2), recall: +(a.recall / reps).toFixed(3), blocked: `${a.blocked}/${reps}` };
      (report[tname] ||= {})[`${pname} | ${src}`] = r;
      console.log(`${tname.padEnd(14)} ${pname.padEnd(20)} ${src.padEnd(11)} ${String(r.eps).padStart(6)}  ${String(r.wrongGo).padStart(7)}  ${String(r.recall).padStart(6)}  ${r.blocked.padStart(7)}`);
    }
  }
}
fs.writeFileSync("experiments/results/auto-tolerance.json", JSON.stringify({ at: new Date().toISOString(), audit: AUDIT, reps: REPS, report }, null, 2));
