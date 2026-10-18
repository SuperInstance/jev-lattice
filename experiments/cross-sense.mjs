#!/usr/bin/env node
/**
 * R3-G: cross-sense teaching on the Cloudflare edge.
 *
 * "If you know something by sight, let that truth calibrate the smell and sound."
 *   teacher  Jev reading only the question's file (per-file, T28) — the strongest channel
 *   senses   jev-whole (all files), jev-paraphrase (MiniMax rewording), workers-ai, compiled
 *
 * Teaching phase: every decided gate labels the senses' readings on the same evidence
 * (label bank in the Durable Object). Test phase: new repos, NO teacher — only senses
 * add proofs, and the Worker's gates use the thresholds/blocks learned from the bank.
 *
 *   node experiments/cross-sense.mjs --worker https://… --key … [--teach-repos 5 --turns 8 --test-repos 5]
 */
import fs from "node:fs";
import { learnThreshold, senseStats } from "../senses.mjs";
import { makeRepoGenerator, REPO_QUESTIONS, REPO_RULES } from "./repo-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WORKER = opt("--worker", "https://jev-lattice.casey-digennaro.workers.dev");
const KEY = opt("--key", process.env.JEV_API_KEY);
const TEACH_REPOS = Number(opt("--teach-repos", 5)), TURNS = Number(opt("--turns", 8)), TEST_REPOS = Number(opt("--test-repos", 5));
const LATTICE = `xsense-${Date.now().toString(36)}`;
// earned-discount policy (see learnThreshold): below FLOOR only with ≥ MIN_GO_DISCOUNT clean GOs
const FLOOR = opt("--floor", null) === null ? null : Number(opt("--floor"));
const MIN_GO_DISCOUNT = Number(opt("--min-go-discount", 0));
const POLICY = { minSamples: 8, minGo: 3, floor: FLOOR, minGoForDiscount: MIN_GO_DISCOUNT };
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const tool = async (name, a) => {
  const r = await fetch(`${WORKER}/api/${LATTICE}/tool/${name}`, { method: "POST", headers: H, body: JSON.stringify(a) });
  const j = await r.json();
  if (j.ok === false) throw new Error(`${name}: ${j.error}`);
  return j;
};

// 1. questions with per-file reads
const ids = [];
for (const [file, q] of REPO_QUESTIONS) {
  ids.push((await tool("jev_ingest", { text: q, question_spec: { confidence_threshold: 0.9, reads: [file] }, linkToNearest: false })).node.id);
}
const byId = Object.fromEntries(ids.map((id, j) => [id, j]));

// two hand-written predicates so the "compiled" sense has something to run
const PRED = {
  4: "t => /^\\s*gzip\\s+on\\s*;/m.test(t)",
  6: "t => /^DEBUG=false\\s*$/m.test(t)"
};
for (const [j, code] of Object.entries(PRED)) {
  const g = makeRepoGenerator(9000 + Number(j));
  const [file, q, truthFn] = REPO_QUESTIONS[j];
  const labels = Array.from({ length: 8 }, () => { const x = g.gen(file); return { text: x.text, expected: truthFn(x.c) }; });
  const r = await tool("jev_predicate_register", { question: q, code, labels });
  console.log(`registered compiled predicate for "${q}": accepted=${r.accepted}`);
}

const filesOf = repo => Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, v.text]));
function* snapshots(seedBase, repos, turns) {
  for (let r = 0; r < repos; r++) {
    const g = makeRepoGenerator(seedBase + r);
    let repo = g.genRepo();
    let rs = seedBase * 7 + r;
    const rnd = () => ((rs = (rs * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < turns; t++) {
      if (t > 0) { const f = g.files[Math.floor(rnd() * g.files.length)]; repo = { ...repo, [f]: g.gen(f) }; }
      yield repo;
    }
  }
}

// 2. teaching phase
const truthBank = {}; // sense → question index → [[p, truth]]
let teacherLabels = 0, teacherWrong = 0;
const t0 = Date.now();
for (const repo of snapshots(300, TEACH_REPOS, TURNS)) {
  const files = filesOf(repo);
  await tool("jev_invalidate_stale", { files });
  await tool("jev_verify_files", { files, rules: REPO_RULES });
  const taught = await tool("jev_teach", { files, rules: REPO_RULES });
  for (const [sense, res] of Object.entries(taught.senses)) {
    for (const row of res.raw || []) {
      const j = byId[row.id];
      const [file, , truthFn] = REPO_QUESTIONS[j];
      const truth = truthFn(repo[file].c);
      ((truthBank[sense] ||= {})[j] ||= []).push([row.p, truth]);
      if (sense === "jev-whole") { teacherLabels++; if (row.label !== truth) teacherWrong++; }
    }
  }
}
console.log(`\nteaching: ${TEACH_REPOS * TURNS} snapshots in ${((Date.now() - t0) / 1000).toFixed(1)} s; teacher labels ${teacherLabels}, wrong ${teacherWrong}`);

// 3. what the bank learned (teacher labels) vs what truth would have taught (same samples)
const report = await tool("jev_sense_report", POLICY);
console.log("\nsense           question                                                    n   acc(teacher)  t(teacher)  t(truth)");
const learnedRows = [];
for (const row of report.rows) {
  const j = byId[row.id];
  const tb = truthBank[row.sense]?.[j] || [];
  const lt = learnThreshold(tb, POLICY);
  learnedRows.push({ sense: row.sense, j, n: row.n, accTeacher: row.acc, tTeacher: row.learned.t, tTruth: lt.t, accTruth: senseStats(tb).acc });
  if (row.n) console.log(`${row.sense.padEnd(15)} ${row.question.slice(0, 58).padEnd(58)} ${String(row.n).padStart(4)}  ${row.acc.toFixed(3).padStart(12)}  ${String(row.learned.t).padStart(10)}  ${String(lt.t).padStart(8)}`);
}
const agree = learnedRows.filter(r => r.n && r.tTeacher === r.tTruth).length, withData = learnedRows.filter(r => r.n).length;
console.log(`\nlearned threshold identical to truth-learned: ${agree}/${withData} (question × sense)`);

// 4. apply in the Worker, then test with NO teacher
await tool("jev_apply_learned", POLICY);
const score = {}; // sense → {default: {go, wrong, yes}, learned: …}
const verdictScore = { go: 0, wrongGo: 0, refuted: 0, wrongRefuted: 0, open: 0, yes: 0, n: 0 };
for (const repo of snapshots(700, TEST_REPOS, 4)) {
  const files = filesOf(repo);
  await tool("jev_invalidate_stale", { files });          // kills any teacher proofs (file hashes differ)
  const probe = await tool("jev_sense_probe", { files, rules: REPO_RULES, addProofs: true });
  const nodes = (await tool("jev_list_nodes", {})).nodes;
  for (const [sense, ps] of Object.entries(probe.probes)) {
    for (const [id, p] of Object.entries(ps)) {
      const j = byId[id];
      const [file, , truthFn] = REPO_QUESTIONS[j];
      const truth = truthFn(repo[file].c);
      const lr = learnedRows.find(r => r.sense === sense && r.j === j);
      const s = (score[sense] ||= { default: { go: 0, wrong: 0, yes: 0 }, learned: { go: 0, wrong: 0, yes: 0 } });
      if (truth) { s.default.yes++; s.learned.yes++; }
      if (p >= 0.9) { s.default.go++; if (!truth) s.default.wrong++; }
      if (lr?.tTeacher != null && p >= lr.tTeacher) { s.learned.go++; if (!truth) s.learned.wrong++; }
    }
  }
  for (const n of nodes.filter(x => x.node_type === "QUESTION")) {
    const j = byId[n.id];
    const [file, , truthFn] = REPO_QUESTIONS[j];
    const truth = truthFn(repo[file].c);
    verdictScore.n++;
    if (truth) verdictScore.yes++;
    if (n.verdict === "GO") { verdictScore.go++; if (!truth) verdictScore.wrongGo++; }
    else if (n.verdict === "REFUTED") { verdictScore.refuted++; if (truth) verdictScore.wrongRefuted++; }
    else verdictScore.open++;
  }
}
console.log("\ntest phase (no teacher): per sense, default 0.9 vs learned thresholds");
console.log("sense           default GO / wrong / recall     learned GO / wrong / recall");
for (const [sense, s] of Object.entries(score)) {
  const f = x => `${String(x.go).padStart(4)} / ${String(x.wrong).padStart(3)} / ${(x.yes ? (x.go - x.wrong) / x.yes : 0).toFixed(3)}`;
  console.log(`${sense.padEnd(15)} ${f(s.default).padEnd(30)}  ${f(s.learned)}`);
}
console.log(`\nWorker gates on senses only (learned thresholds + blocks applied in the DO): ${JSON.stringify(verdictScore)}`);
const out = opt("--out", null);
if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), LATTICE, POLICY, teacherLabels, teacherWrong, learnedRows, score, verdictScore }, null, 2));
