#!/usr/bin/env node
/**
 * Fragility profile (T34; prompted by an external measurement on PR #1).
 * Claim under test: re-ask flips are a near-threshold effect — a reading within ~0.02 of
 * its bar is a coin flip; one far from it never flips — so fragility is predictable from
 * the margin (plus a measured spread) without observing a flip.
 *
 * Take reading #1 as the cached one; take R more readings of the same evidence outside the
 * cache. For t ∈ {0.8, 0.9, 0.95}: flip = any later verdict differs from reading #1's.
 *   node experiments/fragility.mjs [--configs 12] [--repeats 5]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { makeGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const CONFIGS = opt("--configs", 12), R = opt("--repeats", 5);
const jev = createJev();
const items = QUESTIONS.map(([q], j) => ({ key: `q${j}`, instructions: q }));
const cfgs = Array.from({ length: CONFIGS }, makeGenerator(2718));

const rows = [];
await Promise.all(cfgs.map(async c => {
  const st = { "redis.conf": c.text, reading_rules: READING_RULES };
  const runs = await Promise.all(Array.from({ length: R + 1 }, () => jev.nouls(st, items)));
  for (const it of items) rows.push(runs.map(r => r[it.key].p));
}));

const verdict = (p, t) => (p >= t ? "GO" : p <= 1 - t ? "REF" : "OPEN");
const BINS = [[0, 0.02], [0.02, 0.05], [0.05, 0.1], [0.1, 1.01]];
const report = {};
for (const t of [0.8, 0.9, 0.95]) {
  const bins = BINS.map(() => ({ n: 0, flips: 0 }));
  let decided = 0, fragileFlag = 0, flips = 0, flaggedFlips = 0;
  for (const ps of rows) {
    const [first, ...rest] = ps;
    const v0 = verdict(first, t);
    // signed distance of the cached reading from the nearest decision boundary
    const m = Math.max(first - t, 1 - t - first);
    const spread = Math.max(...rest) - Math.min(...rest);
    const flipped = rest.some(p => verdict(p, t) !== v0);
    const b = bins[BINS.findIndex(([lo, hi]) => Math.abs(m) >= lo && Math.abs(m) < hi)];
    b.n++; if (flipped) b.flips++;
    if (v0 !== "OPEN") {
      decided++;
      const fragile = m < Math.max(0.02, spread);
      if (fragile) fragileFlag++;
      if (flipped) { flips++; if (fragile) flaggedFlips++; }
    }
  }
  report[t] = { bins: bins.map((b, i) => ({ band: BINS[i], ...b, rate: b.n ? +(b.flips / b.n).toFixed(3) : null })), decided, fragileFlag, flipsOfDecided: flips, flaggedFlips };
  console.log(`\nt=${t}: |margin| band → flip rate`);
  for (const b of report[t].bins) console.log(`  [${b.band[0].toFixed(2)}, ${b.band[1] > 1 ? "∞" : b.band[1].toFixed(2)})  n=${String(b.n).padStart(3)}  flips=${String(b.flips).padStart(2)}  rate=${b.rate}`);
  console.log(`  decided gates: ${decided}; flagged fragile: ${fragileFlag} (${(fragileFlag / decided * 100).toFixed(1)}%); decided gates that flipped: ${flips}, of which flagged: ${flaggedFlips}`);
}
const allSpread = rows.map(ps => Math.max(...ps) - Math.min(...ps)).sort((a, b) => a - b);
console.log(`\nspread over ${R + 1} readings: median ${allSpread[Math.floor(allSpread.length / 2)].toFixed(3)}, p90 ${allSpread[Math.floor(allSpread.length * 0.9)].toFixed(3)}, max ${allSpread.at(-1).toFixed(3)}  (${rows.length} questions)`);
if (args.includes("--out")) fs.writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify({ at: new Date().toISOString(), CONFIGS, R, report }, null, 2));
