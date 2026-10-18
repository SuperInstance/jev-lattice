#!/usr/bin/env node
/**
 * R6: which documented TypeSafe levers fix Jev's weak spots? Hard bench (hard-gen.mjs).
 *   base         {files, reading_rules} + plain question                       (R6 hard baseline)
 *   criteria     + Noul criteria {true:{what}, false:{what, not_for}}
 *   structured   + instructions {question, focus (backticked path), rule}
 *   both         criteria + structured
 *   facts        + code-derived facts in state (units → bytes, effective values, counts)
 *   choice3      Choice yes / no / insufficient_evidence, p = P(yes)
 *   negation     Q and ¬Q (by "Is it false that …") in one call: does |p+pn−1| flag errors?
 *   node experiments/typesafe-levers.mjs [--per 25] [--model jev-1.13.0]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { makeHardGenerator, FAMILY_HINTS } from "./hard-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PER = Number(opt("--per", 25)), T = 0.9;
const jev = createJev({ model: opt("--model", "jev-1.13.0") });
const g = makeHardGenerator(Number(opt("--seed", 9)));
const cases = g.families.flatMap(f => Array.from({ length: PER }, () => g.next(f)));

const st = (c, extra = {}) => ({ files: c.files, reading_rules: c.rules, ...extra });
const ARMS = {
  base: c => ({ state: st(c), q: { type: "noul", instructions: c.question } }),
  criteria: c => ({ state: st(c), q: { type: "noul", instructions: c.question, criteria: { true: FAMILY_HINTS[c.family].true, false: FAMILY_HINTS[c.family].false } } }),
  structured: c => ({ state: st(c), q: { type: "noul", instructions: { question: c.question, focus: FAMILY_HINTS[c.family].focus, rule: c.rules } } }),
  both: c => ({ state: st(c), q: { type: "noul", instructions: { question: c.question, focus: FAMILY_HINTS[c.family].focus, rule: c.rules }, criteria: { true: FAMILY_HINTS[c.family].true, false: FAMILY_HINTS[c.family].false } } }),
  facts: c => ({ state: st(c, { derived_facts: c.facts, derived_facts_note: "computed by code from the files; authoritative" }), q: { type: "noul", instructions: c.question } }),
  choice3: c => ({ state: st(c), q: { type: "choice", instructions: c.question, criteria: { yes: "the answer is yes", no: "the answer is no", insufficient_evidence: "the files do not settle the question" } } })
};
const pOf = (a, arm) => (arm === "choice3" ? a.probabilities.yes : a.noul);
const out = { model: jev.model, per: PER, at: new Date().toISOString(), arms: {} };
for (const [arm, build] of Object.entries(ARMS)) {
  const ps = await Promise.all(cases.map(c => { const b = build(c); return jev.ask(b.state, { q: b.q }).then(d => pOf(d.answers.q, arm)); }));
  const fam = {}, tot = { n: 0, correct: 0, wrongGo: 0, wrongNo: 0, open: 0, brier: 0 };
  cases.forEach((c, i) => {
    const f = (fam[c.family] ||= { n: 0, correct: 0, wrongGo: 0, wrongNo: 0, open: 0 });
    const p = ps[i];
    for (const x of [f, tot]) { x.n++; if (p >= T) c.truth ? x.correct++ : x.wrongGo++; else if (p <= 1 - T) !c.truth ? x.correct++ : x.wrongNo++; else x.open++; }
    tot.brier += (p - (c.truth ? 1 : 0)) ** 2;
  });
  tot.brier = +(tot.brier / tot.n).toFixed(4);
  out.arms[arm] = { total: tot, families: fam };
  console.log(`${arm.padEnd(10)} correct ${tot.correct}/${tot.n} wrongGO ${tot.wrongGo} wrongNO ${tot.wrongNo} open ${tot.open} brier ${tot.brier}  | ${Object.entries(fam).map(([k, f]) => `${k}:${f.correct}${f.wrongGo + f.wrongNo ? `!${f.wrongGo + f.wrongNo}` : ""}`).join(" ")}`);
}
// negation coherence on the base arm
const pairs = await Promise.all(cases.map(c => jev.ask(st(c), { q: { type: "noul", instructions: c.question }, n: { type: "noul", instructions: `Is it false that the following holds? ${c.question}` } }).then(d => ({ p: d.answers.q.noul, pn: d.answers.n.noul, truth: c.truth, family: c.family }))));
const err = r => (r.p >= T || r.p <= 1 - T) && (r.p >= T) !== r.truth;
const gap = r => Math.abs(r.p + r.pn - 1);
out.negation = {
  mean_gap: +(pairs.reduce((s, r) => s + gap(r), 0) / pairs.length).toFixed(4),
  errors: pairs.filter(err).length,
  errors_with_gap_gt_0_2: pairs.filter(r => err(r) && gap(r) > 0.2).length,
  decided_with_gap_gt_0_2: pairs.filter(r => (r.p >= T || r.p <= 1 - T) && gap(r) > 0.2).length,
  per_family_gap: Object.fromEntries(g.families.map(f => [f, +(pairs.filter(r => r.family === f).reduce((s, r) => s + gap(r), 0) / PER).toFixed(3)]))
};
console.log("negation", JSON.stringify(out.negation));
out.usage = jev.usage;
fs.writeFileSync(new URL(`./results/typesafe-levers-${jev.model}.json`, import.meta.url), JSON.stringify(out, null, 2));
