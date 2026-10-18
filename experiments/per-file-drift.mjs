#!/usr/bin/env node
/**
 * R3-C: per-file evidence channels vs one whole-state hash.
 * A 3-file repo; each turn one random file changes (or reverts); the agent re-checks.
 *   whole   proofs keyed by the hash of the whole repo; every change retires every proof
 *   perfile questions declare `reads`; proofs keyed per file; Jev sees only the read files
 * Both use the proof cache. Metrics: Jev questions, wrong GOs, accuracy, and accuracy
 * of focused (one-file) vs whole-repo state on the very first turn.
 *   node experiments/per-file-drift.mjs [--turns 12] [--repos 6]
 */
import fs from "node:fs";
import { JEVLattice } from "../jev-core.js";
import { createJev } from "../providers/jev.mjs";
import { cachedJev, createProofCache } from "../proof-cache.mjs";
import * as orch from "../orchestrator.mjs";
import { makeRepoGenerator, REPO_QUESTIONS, REPO_RULES } from "./repo-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const TURNS = opt("--turns", 12), REPOS = opt("--repos", 6);

function meter(jev) {
  const m = { calls: 0, questions: 0 };
  const inner = jev.nouls;
  jev.nouls = async (st, items) => { m.calls++; m.questions += items.length; return inner(st, items); };
  return m;
}

async function run(mode) {
  const raw = createJev();
  const m = meter(raw);
  const jev = cachedJev(raw, createProofCache());
  const agg = { wrongGo: 0, correct: 0, n: 0, firstTurn: { correct: 0, n: 0 } };
  for (let r = 0; r < REPOS; r++) {
    const g = makeRepoGenerator(100 + r);
    let repo = g.genRepo();
    const history = { ...Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, [v]])) };
    let rs = 500 + r;
    const rnd = () => ((rs = (rs * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const L = new JEVLattice();
    const ids = REPO_QUESTIONS.map(([file, q]) =>
      L.ingest({ text: q, question_spec: { confidence_threshold: 0.9, ...(mode === "perfile" ? { reads: [file] } : {}) }, linkToNearest: false }).node.id);
    for (let t = 0; t < TURNS; t++) {
      if (t > 0) {
        // change one file: 30% of the time revert it to an earlier version
        const f = g.files[Math.floor(rnd() * g.files.length)];
        const h = history[f];
        repo = { ...repo, [f]: rnd() < 0.3 && h.length > 1 ? h[Math.floor(rnd() * (h.length - 1))] : g.gen(f) };
        h.push(repo[f]);
      }
      const files = Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, v.text]));
      if (mode === "perfile") {
        await orch.invalidateChangedFiles(L, { files });
        await orch.verifyFiles(L, { jev, files, rules: REPO_RULES });
      } else {
        const state = { files, reading_rules: REPO_RULES };
        await orch.invalidateStale(L, { state, channel: "repo" });
        await orch.verifyOpenGates(L, { jev, state, channel: "repo" });
      }
      REPO_QUESTIONS.forEach(([file, , truthFn], j) => {
        const v = L.evaluateGoNoGo(ids[j]).verdict;
        const truth = truthFn(repo[file].c);
        agg.n++;
        if ((v === "GO" && truth) || (v === "REFUTED" && !truth)) agg.correct++;
        if (v === "GO" && !truth) agg.wrongGo++;
        if (t === 0) { agg.firstTurn.n++; if ((v === "GO" && truth) || (v === "REFUTED" && !truth)) agg.firstTurn.correct++; }
      });
    }
  }
  return { mode, jevCalls: m.calls, jevQuestions: m.questions, cacheHits: jev.cache.stats.hits, decidedCorrect: +(agg.correct / agg.n).toFixed(3), wrongGo: agg.wrongGo, firstTurnDecidedCorrect: +(agg.firstTurn.correct / agg.firstTurn.n).toFixed(3) };
}

const out = [];
for (const mode of ["whole", "perfile"]) out.push(await run(mode));
console.log(`${REPOS} repos × ${REPO_QUESTIONS.length} questions × ${TURNS} turns (one file changes per turn)\n`);
console.log("mode      jevCalls  jevQuestions  cacheHits  decided&correct  wrongGO  turn-0 decided&correct");
for (const r of out) console.log(`${r.mode.padEnd(8)}  ${String(r.jevCalls).padStart(8)}  ${String(r.jevQuestions).padStart(12)}  ${String(r.cacheHits).padStart(9)}  ${r.decidedCorrect.toFixed(3).padStart(15)}  ${String(r.wrongGo).padStart(7)}  ${r.firstTurnDecidedCorrect.toFixed(3).padStart(22)}`);
if (args.includes("--out")) fs.writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify({ at: new Date().toISOString(), TURNS, REPOS, out }, null, 2));
