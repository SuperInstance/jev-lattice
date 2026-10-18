#!/usr/bin/env node
/**
 * Proof-cache experiment: an agent re-checks its gates every turn while some
 * configs drift. Three strategies run on the same drift schedule:
 *
 *   naive        no cache; each turn invalidate every Jev proof, re-ask everything
 *   hash         no cache; invalidate by state hash per channel, re-ask open gates
 *   hash+cache   cache by (state hash, question); invalidate by hash; re-ask open gates
 *
 *   node experiments/proof-cache.mjs [--configs 20] [--turns 8] [--drift 0.15] [--out file]
 *
 * Metrics: Jev questions/calls/tokens/wall, verdict flips on gates whose evidence did NOT
 * change (should be 0 — same evidence, same verdict), wrong GOs vs code ground truth.
 */
import fs from "node:fs";
import { JEVLattice } from "../jev-core.js";
import { createJev } from "../providers/jev.mjs";
import { cachedJev, createProofCache } from "../proof-cache.mjs";
import * as orch from "../orchestrator.mjs";
import { makeGenerator, QUESTIONS } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CONFIGS = Number(opt("--configs", 20));
const TURNS = Number(opt("--turns", 8));
const DRIFT = Number(opt("--drift", 0.15));
const OUT = opt("--out", null);
const RULES = "later directives override earlier ones; lines starting with # are comments.";

// one shared drift schedule so all strategies see identical evidence
const gen = makeGenerator(Number(opt("--seed", 42)));
let seed = 1234;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const schedule = [Array.from({ length: CONFIGS }, gen)];
for (let t = 1; t < TURNS; t++) {
  schedule.push(schedule[t - 1].map(c => (rnd() < DRIFT ? gen() : c)));
}
const driftCount = schedule.slice(1).reduce((s, turn, t) => s + turn.filter((c, i) => c !== schedule[t][i]).length, 0);
const stateOf = c => ({ "redis.conf": c.text, reading_rules: RULES });

function usageMeter(jev) {
  // count what actually reaches the provider (beneath any cache)
  const m = { calls: 0, questions: 0, input_tokens: 0, output_tokens: 0 };
  const inner = jev.nouls;
  jev.nouls = async (state, items) => {
    const r = await inner(state, items);
    m.calls++;
    m.questions += items.length;
    m.input_tokens += r._usage?.input_tokens || 0;
    m.output_tokens += r._usage?.output_tokens || 0;
    return r;
  };
  return m;
}

async function run(name) {
  const raw = createJev();
  const meter = usageMeter(raw);
  const jev = name === "hash+cache" ? cachedJev(raw, createProofCache()) : raw;
  const L = new JEVLattice();
  const ids = schedule[0].map((_, ci) =>
    QUESTIONS.map(([q]) => L.ingest({ text: `[cfg ${ci}] ${q}`, question_spec: { confidence_threshold: 0.9 }, linkToNearest: false }).node.id)
  );
  // verifier sees the bare question; node text carries the config label for humans
  const instr = id => L.getNode(id).text.replace(/^\[cfg \d+\] /, "");
  const items = list => list.map(id => ({ key: id, instructions: instr(id) }));

  let flipsUnchanged = 0, cacheHits = 0;
  const t0 = Date.now();
  let prev = null;
  for (let t = 0; t < TURNS; t++) {
    const turn = schedule[t];
    await Promise.all(turn.map(async (cfg, ci) => {
      const st = stateOf(cfg);
      const channel = `cfg-${ci}`;
      if (name === "naive") {
        for (const id of ids[ci]) for (const p of L.getNode(id).active_proofs) if (!p.invalidated) L.invalidateProof(id, p.proof_id, "turn");
      } else {
        await orch.invalidateStale(L, { state: st, channel });
      }
      const open = ids[ci].filter(id => L.evaluateGoNoGo(id).open);
      if (!open.length) return;
      const ans = await jev.nouls(st, items(open));
      cacheHits += ans._cache?.hits || 0;
      const { stateHash } = await import("../proof-cache.mjs");
      const h = ans._state_hash ?? (await stateHash(st));
      for (const id of open) {
        L.addProof(id, { source_type: "JEV_NOUL", provider: "typesafe", confidence: ans[id].p, cost_weight: 0.05, evidence: { state_hash: h, channel } });
      }
    }));
    const verdicts = ids.map(list => list.map(id => L.evaluateGoNoGo(id).verdict));
    if (prev) {
      turn.forEach((cfg, ci) => {
        if (cfg !== schedule[t - 1][ci]) return; // evidence changed — a flip is legitimate
        verdicts[ci].forEach((v, j) => { if (v !== prev[ci][j]) flipsUnchanged++; });
      });
    }
    prev = verdicts;
  }
  const wall = Date.now() - t0;
  let wrongGo = 0, wrongRefute = 0, go = 0, open = 0;
  schedule.at(-1).forEach((cfg, ci) => ids[ci].forEach((id, j) => {
    const v = L.evaluateGoNoGo(id).verdict;
    const truth = QUESTIONS[j][1](cfg.c);
    if (v === "GO") { go++; if (!truth) wrongGo++; }
    if (v === "OPEN") open++;
    if (v === "REFUTED" && truth) wrongRefute++;
  }));
  return { strategy: name, ...meter, cacheHits, wall_ms: wall, flipsUnchanged, final: { go, open, wrongGo, wrongRefute } };
}

console.log(`${CONFIGS} configs × ${QUESTIONS.length} questions, ${TURNS} turns, drift ${DRIFT} → ${driftCount} config changes`);
const results = [];
for (const s of ["naive", "hash", "hash+cache"]) results.push(await run(s));

console.log("\nstrategy      jevQ   calls  in_tok   wall_ms  cacheHits  flips(unchanged)  final GO/OPEN  wrongGO  wrongREF");
for (const r of results) {
  console.log(`${r.strategy.padEnd(12)} ${String(r.questions).padStart(5)}  ${String(r.calls).padStart(5)}  ${String(r.input_tokens).padStart(6)}  ${String(r.wall_ms).padStart(7)}  ${String(r.cacheHits).padStart(9)}  ${String(r.flipsUnchanged).padStart(16)}  ${`${r.final.go}/${r.final.open}`.padStart(13)}  ${String(r.final.wrongGo).padStart(7)}  ${String(r.final.wrongRefute).padStart(8)}`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), CONFIGS, TURNS, DRIFT, driftCount, results }, null, 2));
