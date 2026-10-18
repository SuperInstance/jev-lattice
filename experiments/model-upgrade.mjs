#!/usr/bin/env node
/**
 * R5-E: what does a verifier model upgrade do to verdicts?
 *
 * Same labelled bench (redis-gen), three passes: jev-1.13.0 twice (the within-model
 * re-ask noise floor) and jev-1.14.0 once. A verdict flip between models that exceeds
 * the re-ask flip rate is change caused by the upgrade, which is the case for pinning.
 *
 *   node experiments/model-upgrade.mjs [--n 30] [--seed 11] [--threshold 0.9]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { makeGenerator, QUESTIONS } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt("--n", 30)), T = Number(opt("--threshold", 0.9));
const OLD = opt("--old", "jev-1.13.0"), NEW = opt("--new", "jev-1.14.0");
const gen = makeGenerator(Number(opt("--seed", 11)));
const RULES = "later directives override earlier ones; lines starting with # are comments.";

const items = Array.from({ length: N }, (_, i) => {
  const { c, text } = gen();
  return { i, text, qs: QUESTIONS.map(([q, f], j) => ({ key: `q${j}`, q, truth: f(c) })) };
});

async function pass(model) {
  const jev = createJev({ model });
  const out = new Map();
  const queue = [...items];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let it; (it = queue.shift()); ) {
      const ans = await jev.nouls({ "redis.conf": it.text, reading_rules: RULES }, it.qs.map(x => ({ key: x.key, instructions: x.q })));
      for (const x of it.qs) out.set(`${it.i}:${x.key}`, { p: ans[x.key].p, truth: x.truth, served: ans._model });
    }
  }));
  return out;
}
const verdict = p => (p >= T ? "GO" : p <= 1 - T ? "REFUTED" : "OPEN");

const t0 = Date.now();
const [a1, a2, b] = await Promise.all([pass(OLD), pass(OLD), pass(NEW)]);
const keys = [...a1.keys()];
const cmp = (x, y) => {
  let flips = 0, dp = 0, near = 0;
  const kinds = {};
  for (const k of keys) {
    const vx = verdict(x.get(k).p), vy = verdict(y.get(k).p);
    dp += Math.abs(x.get(k).p - y.get(k).p);
    if (vx !== vy) { flips++; kinds[`${vx}→${vy}`] = (kinds[`${vx}→${vy}`] || 0) + 1; if (Math.min(Math.abs(x.get(k).p - T), Math.abs(x.get(k).p - (1 - T))) < 0.02) near++; }
  }
  return { flips, rate: +(flips / keys.length).toFixed(3), mean_abs_dp: +(dp / keys.length).toFixed(4), flips_within_0_02_of_bar: near, kinds };
};
const quality = m => {
  let wrongGo = 0, go = 0, correct = 0, open = 0;
  for (const k of keys) {
    const { p, truth } = m.get(k), v = verdict(p);
    if (v === "GO") { go++; if (!truth) wrongGo++; }
    if (v === "OPEN") open++;
    if ((v === "GO" && truth) || (v === "REFUTED" && !truth)) correct++;
  }
  return { decided_correct: correct, go, wrong_go: wrongGo, open, n: keys.length };
};
const res = {
  n_cases: keys.length, threshold: T, old: OLD, new: NEW,
  served: { old: a1.get(keys[0]).served, new: b.get(keys[0]).served },
  reask_noise: cmp(a1, a2), upgrade: cmp(a1, b), upgrade_vs_second_reask: cmp(a2, b),
  quality: { [`${OLD}#1`]: quality(a1), [`${OLD}#2`]: quality(a2), [NEW]: quality(b) },
  wall_ms: Date.now() - t0
};
console.log(JSON.stringify(res, null, 2));
fs.writeFileSync(new URL(`./results/model-upgrade-s${opt("--seed", 11)}.json`, import.meta.url), JSON.stringify(res, null, 2));
