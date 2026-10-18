#!/usr/bin/env node
/**
 * R6 end-to-end: do the lab gains survive the product path? Hard bench families through
 * verifyFiles, with fact specs a gate author would write (facts.mjs extractors, not the
 * generator's oracle facts) plus focus/criteria from FAMILY_HINTS.
 *   plain     verifyFiles(files, rules)
 *   product   + facts (facts.mjs) + focus + criteria
 */
import fs from "node:fs";
import { JEVLattice } from "../jev-core.js";
import { verifyFiles } from "../orchestrator.mjs";
import { factsForFiles } from "../facts.mjs";
import { createJev } from "../providers/jev.mjs";
import { makeHardGenerator, FAMILY_HINTS } from "./hard-gen.mjs";

const T = 0.9, PER = 20;
const SPECS = {
  units: { "redis.conf": [{ name: "maxmemory_bytes", extract: "size", key: "maxmemory" }] },
  override: { "redis.conf": [{ name: "effective_appendonly", extract: "directive", key: "appendonly", default: "no (default)" }] },
  default: { "redis.conf": [{ name: "effective_protected_mode", extract: "directive", key: "protected-mode", default: "yes (default)" }] },
  duration: { "service.yaml": [{ name: "read_timeout_ms", extract: "duration", key: "read_timeout" }] },
  nested: { "config.json": [{ name: "security.audit.enabled", extract: "json", path: "security.audit.enabled" }] },
  count: { "users.yaml": [{ name: "admin_count", extract: "count", pattern: "role:\\s*admin\\s*$" }] }
};
const out = { at: new Date().toISOString(), per: PER, results: {} };
for (const model of ["jev-1.13.0", "jev-1.14.0"]) {
  const jev = createJev({ model });
  const g = makeHardGenerator(123);
  for (const fam of Object.keys(SPECS)) {
    const cases = Array.from({ length: PER }, () => g.next(fam));
    for (const arm of ["plain", "product"]) {
      let correct = 0, wrong = 0, open = 0;
      await Promise.all(cases.map(async c => {
        const L = new JEVLattice();
        const spec = { confidence_threshold: T, reads: Object.keys(c.files), ...(arm === "product" ? { focus: FAMILY_HINTS[fam].focus.replace(/`files\.[^`]+`/g, "the file"), criteria: { true: FAMILY_HINTS[fam].true, false: FAMILY_HINTS[fam].false } } : {}) };
        const id = L.ingest({ text: c.question, question_spec: spec, linkToNearest: false }).node.id;
        await verifyFiles(L, { jev, files: c.files, rules: c.rules, facts: arm === "product" ? factsForFiles(c.files, SPECS[fam]) : null });
        const v = L.evaluateGoNoGo(id).verdict;
        if (v === "GO" || v === "REFUTED") ((v === "GO") === c.truth ? correct++ : wrong++); else open++;
      }));
      (out.results[`${model} | ${arm}`] ||= {})[fam] = { correct, wrong, open };
    }
  }
  for (const arm of ["plain", "product"]) {
    const r = out.results[`${model} | ${arm}`];
    const t = Object.values(r).reduce((a, x) => ({ correct: a.correct + x.correct, wrong: a.wrong + x.wrong, open: a.open + x.open }), { correct: 0, wrong: 0, open: 0 });
    console.log(`${model} ${arm.padEnd(8)} total correct ${t.correct}/${PER * 6} wrong ${t.wrong} open ${t.open} | ${Object.entries(r).map(([k, x]) => `${k}:${x.correct}${x.wrong ? `!${x.wrong}` : ""}`).join(" ")}`);
  }
}
fs.writeFileSync(new URL("./results/typesafe-product.json", import.meta.url), JSON.stringify(out, null, 2));
