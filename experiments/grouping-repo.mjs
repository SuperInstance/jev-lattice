#!/usr/bin/env node
/**
 * R5-B: does Choice-first grouping generalise beyond redis.conf?
 * grouping.mjs on the 3-file repo generator (redis.conf, nginx.conf, app.env) with the 9
 * REPO_QUESTIONS plus 4 questions that share a field with one of them (so there is
 * something real to group) — per-file, triggered by groupCandidates (≥ 3 per file).
 * Validation on 20 repos, held-out 40 repos scored against generator truth.
 *   node experiments/grouping-repo.mjs
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax } from "../providers/minimax.mjs";
import { reliability } from "../calibration.mjs";
import { groupCandidates, proposeGroups, validateGroups, createGroupedAsker } from "../grouping.mjs";
import { makeRepoGenerator, REPO_QUESTIONS, REPO_RULES } from "./repo-gen.mjs";

const EXTRA = [
  ["nginx.conf", "Does nginx listen only on plain HTTP port 80?", c => !c.ssl],
  ["app.env", "Is DEBUG enabled in app.env?", c => c.debug],
  ["app.env", "Is LOG_LEVEL set to debug?", c => c.level === "debug"],
  ["app.env", "Is LOG_LEVEL set to warn?", c => c.level === "warn"]
];
const ALL = [...REPO_QUESTIONS, ...EXTRA].map(([file, text, truth], i) => ({ key: `q${i}`, text, reads: [file], truth, file }));
const jev = createJev(), mm = createMiniMax();
const stateOf = (repo, file) => ({ [file]: repo[file].text, reading_rules: REPO_RULES });

const train = Array.from({ length: 20 }, makeRepoGenerator(501).genRepo);
const test = Array.from({ length: 40 }, makeRepoGenerator(602).genRepo);
const cands = groupCandidates(ALL);
console.log(`auto-trigger: ${cands.map(c => `${c.file} (${c.questions.length} questions)`).join(", ")}`);

const out = { files: {}, totals: {} };
const rows = { derived: [], noulSame: [] };
let askedGrouped = 0, askedNoul = 0;
for (const { file, questions } of cands) {
  const groups = await proposeGroups({ mm, questions, context: `a ${file} file` });
  const { accepted, report } = await validateGroups({ jev, questions, groups, states: train.map(r => stateOf(r, file)) });
  const asker = createGroupedAsker({ jev, questions, groups, accepted });
  const plain = createGroupedAsker({ jev, questions, groups: [], accepted: {} });
  const ans = await Promise.all(test.map(async r => ({ r, g: await asker.ask(stateOf(r, file)), n: await plain.ask(stateOf(r, file)) })));
  const per = {};
  for (const { r, g, n } of ans) for (const q of questions) {
    if (!accepted[q.key]) continue;
    const truth = q.truth(r[file].c);
    rows.derived.push({ p: g.p[q.key], truth });
    rows.noulSame.push({ p: n.p[q.key], truth });
    (per[q.key] ||= { text: q.text, derived: [], noul: [] });
    per[q.key].derived.push({ p: g.p[q.key], truth });
    per[q.key].noul.push({ p: n.p[q.key], truth });
  }
  askedGrouped += asker.questionsPerState * test.length;
  askedNoul += questions.length * test.length;
  out.files[file] = {
    proposed: groups.map(g => ({ choice: g.choice.instructions, options: Object.keys(g.choice.criteria), derived: g.derived })),
    report, accepted: Object.keys(accepted), questionsPerState: `${questions.length} → ${asker.questionsPerState}`,
    perQuestion: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { text: v.text, derived: summary(v.derived), noul: summary(v.noul) }]))
  };
  console.log(`\n${file}: ${groups.length} groups proposed, accepted ${Object.keys(accepted).length}/${questions.length} questions; per state ${questions.length} → ${asker.questionsPerState}`);
  for (const g of groups) console.log(`  · "${g.choice.instructions}" [${Object.keys(g.choice.criteria).join("|")}] → ${g.derived.map(d => `${d.key}${report[d.key]?.ok && accepted[d.key] ? "✓" : "✗"}∈{${d.allowed}}`).join(" ")}`);
  for (const [k, v] of Object.entries(out.files[file].perQuestion)) console.log(`    ${k} ${v.text.slice(0, 50).padEnd(50)} derived ${fmt(v.derived)} | noul ${fmt(v.noul)}`);
}
function summary(rs) { const m = reliability(rs); return { brier: +m.brier.toFixed(4), ece: +m.ece.toFixed(4), go: m.gate[0.9].go, wrongGo: m.gate[0.9].wrongGo, recall: +m.gate[0.9].recall.toFixed(3) }; }
function fmt(s) { return `brier ${s.brier} recall ${s.recall} wrongGO ${s.wrongGo}`; }
out.totals = { derived: rows.derived.length ? summary(rows.derived) : null, noul: rows.noulSame.length ? summary(rows.noulSame) : null, questionsAsked: { grouped: askedGrouped, nouls: askedNoul } };
console.log(`\ntotal on accepted questions: derived ${out.totals.derived && fmt(out.totals.derived)} | nouls ${out.totals.noul && fmt(out.totals.noul)}`);
console.log(`questions asked on held-out: ${askedNoul} as Nouls → ${askedGrouped} grouped`);
console.log(`usage: jev ${JSON.stringify(jev.usage)} minimax ${JSON.stringify(mm.usage)}`);
fs.writeFileSync("experiments/results/grouping-repo.json", JSON.stringify({ at: new Date().toISOString(), ...out }, null, 2));
