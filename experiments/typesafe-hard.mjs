#!/usr/bin/env node
/**
 * R6: where does Jev fail? The hard bench (hard-gen.mjs), per family, with and without the
 * family's reading rules, and with the "described" framing; both models.
 *   node experiments/typesafe-hard.mjs [--per 25] [--models jev-1.13.0,jev-1.14.0]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { makeHardGenerator } from "./hard-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PER = Number(opt("--per", 25)), T = 0.9;
const g = makeHardGenerator(Number(opt("--seed", 5)));
const cases = g.families.flatMap(f => Array.from({ length: PER }, () => g.next(f)));
const FR = {
  "files only": c => ({ files: c.files }),
  "files + rules": c => ({ files: c.files, reading_rules: c.rules }),
};
const out = { per: PER, at: new Date().toISOString(), results: {} };
for (const model of opt("--models", "jev-1.13.0,jev-1.14.0").split(",")) {
  const jev = createJev({ model });
  for (const [fname, frame] of Object.entries(FR)) {
    const ps = await Promise.all(cases.map(c => jev.noul(frame(c), c.question).then(r => r.p)));
    const byFam = {};
    cases.forEach((c, i) => {
      const f = (byFam[c.family] ||= { n: 0, correct: 0, wrongGo: 0, wrongNo: 0, open: 0, brier: 0 });
      const p = ps[i]; f.n++; f.brier += (p - (c.truth ? 1 : 0)) ** 2;
      if (p >= T) c.truth ? f.correct++ : f.wrongGo++;
      else if (p <= 1 - T) !c.truth ? f.correct++ : f.wrongNo++;
      else f.open++;
    });
    for (const f of Object.values(byFam)) f.brier = +(f.brier / f.n).toFixed(3);
    out.results[`${model} | ${fname}`] = byFam;
    console.log(`\n${model} | ${fname}`);
    for (const [k, f] of Object.entries(byFam)) console.log(`  ${k.padEnd(9)} correct ${String(f.correct).padStart(2)}/${f.n}  wrongGO ${f.wrongGo}  wrongNO ${f.wrongNo}  open ${f.open}  brier ${f.brier}`);
  }
}
fs.writeFileSync(new URL("./results/typesafe-hard.json", import.meta.url), JSON.stringify(out, null, 2));
