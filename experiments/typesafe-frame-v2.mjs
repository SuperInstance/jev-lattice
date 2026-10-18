#!/usr/bin/env node
/**
 * R6: should the default evidence frame change? Current verifyFiles frame vs v2
 * (policy + untrusted_files + per-file descriptions + rules), on the redis bench (normal),
 * the multi-file repo bench and the hard bench. Both models.
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { makeGenerator, makeShiftedGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";
import { makeRepoGenerator, REPO_QUESTIONS, REPO_RULES } from "./repo-gen.mjs";
import { makeHardGenerator } from "./hard-gen.mjs";
import { frameEvidence } from "../orchestrator.mjs";

const T = 0.9;
const v1 = (files, rules) => ({ files, ...(rules ? { reading_rules: rules } : {}) });
const v2 = (files, rules) => frameEvidence(files, { rules, quarantine: true });
const suites = [];
const r = makeGenerator(91), rs = makeShiftedGenerator(92);
for (const x of [...Array.from({ length: 25 }, r), ...Array.from({ length: 25 }, rs)]) QUESTIONS.forEach(([q, f]) => suites.push({ suite: "redis", files: { "redis.conf": x.text }, rules: READING_RULES, q, truth: f(x.c) }));
const rg = makeRepoGenerator(93);
for (let i = 0; i < 25; i++) { const repo = rg.genRepo(); REPO_QUESTIONS.forEach(([file, q, f]) => suites.push({ suite: "repo", files: { [file]: repo[file].text }, rules: REPO_RULES, q, truth: f(repo[file].c) })); }
const hg = makeHardGenerator(94);
for (const fam of hg.families) for (let i = 0; i < 15; i++) { const c = hg.next(fam); suites.push({ suite: "hard", files: c.files, rules: c.rules, q: c.question, truth: c.truth }); }
const out = { at: new Date().toISOString(), n: suites.length, results: {} };
for (const model of ["jev-1.13.0", "jev-1.14.0"]) {
  const jev = createJev({ model });
  for (const [fname, frame] of Object.entries({ v1, v2 })) {
    const ps = await Promise.all(suites.map(s => jev.noul(frame(s.files, s.rules), s.q).then(x => x.p)));
    const agg = {};
    suites.forEach((s, i) => {
      const a = (agg[s.suite] ||= { n: 0, correct: 0, wrongGo: 0, wrongNo: 0, open: 0, brier: 0 }), p = ps[i];
      a.n++; a.brier += (p - (s.truth ? 1 : 0)) ** 2;
      if (p >= T) s.truth ? a.correct++ : a.wrongGo++; else if (p <= 1 - T) !s.truth ? a.correct++ : a.wrongNo++; else a.open++;
    });
    for (const a of Object.values(agg)) a.brier = +(a.brier / a.n).toFixed(4);
    out.results[`${model} | ${fname}`] = agg;
    console.log(`${model} ${fname}  ${Object.entries(agg).map(([k, a]) => `${k}: ${a.correct}/${a.n} wGO ${a.wrongGo} wNO ${a.wrongNo} brier ${a.brier}`).join("  |  ")}`);
  }
}
fs.writeFileSync(new URL("./results/typesafe-frame-v2.json", import.meta.url), JSON.stringify(out, null, 2));
