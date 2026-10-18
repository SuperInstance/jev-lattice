#!/usr/bin/env node
/**
 * Compiled-first scheduling under distribution shift (backlog 2).
 *
 *   1. compile predicates on in-distribution configs (MiniMax writes, Jev grades)
 *   2. stream 30 in-distribution configs, then 30 SHIFTED ones (uppercase directives,
 *      quotes, tabs, gb units, overrides — same semantics, new surface)
 *   3. compare strategies on the same stream:
 *        all-jev            Jev answers everything
 *        compiled-only      predicates answer; Jev only when a predicate throws
 *        compiled+spot      predicates first, ε-random spot-check with Jev quarantines disagreeing ones
 *        compiled+spot+heal as above, quarantined predicates recompiled from their counterexamples
 *
 *   node experiments/compiled-first.mjs [--eps 0.2] [--n 30]
 */
import vm from "node:vm";
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, MINIMAX_FAST_MODEL } from "../providers/minimax.mjs";
import { compilePredicate, createPredicateRegistry, answerCompiledFirst, healQuarantined } from "../compiled.mjs";
import { makeGenerator, makeShiftedGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const EPS = opt("--eps", 0.2), N = opt("--n", 30);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
// --compile-rules base: predicates are written under the OLD reading rules (no case/quote/tab/gb
// rules) — the format then changes and only Jev is told, via state. Realistic drift.
const BASE_RULES = "later directives override earlier ones; lines starting with # are comments.";
const COMPILE_RULES = args.includes("--compile-rules") && args[args.indexOf("--compile-rules") + 1] === "base" ? BASE_RULES : READING_RULES;

/** node:vm is NOT a sandbox — local R&D only. */
function sandbox(src) {
  const ctx = vm.createContext(Object.create(null));
  const fn = vm.runInContext(`(${src})`, ctx, { timeout: 50 });
  if (typeof fn !== "function") throw new Error("not a function");
  ctx.__fn = fn;
  return text => { ctx.__t = text; return vm.runInContext("__fn(__t)", ctx, { timeout: 50 }) === true; };
}

const jev = createJev();
const mm = createMiniMax({ model: MINIMAX_FAST_MODEL });
const stateOf = t => ({ "redis.conf": t, reading_rules: READING_RULES });
const items = QUESTIONS.map(([q], j) => ({ key: `q${j}`, question: q }));

// 1. compile on in-distribution data
const train = Array.from({ length: 20 }, makeGenerator(101));
const labels = await Promise.all(train.map(t => jev.nouls(stateOf(t.text), items.map(i => ({ key: i.key, instructions: i.question })))));
const examples = train.slice(0, 3).map(t => t.text);
const t0 = Date.now();
const LOAD = args.includes("--load") ? args[args.indexOf("--load") + 1] : null;
const compiled = LOAD
  ? JSON.parse(fs.readFileSync(LOAD, "utf8")).compiled.map(c => (c.accepted ? { ...c, fn: sandbox(c.code) } : c))
  : await Promise.all(items.map((it, j) => compilePredicate({
      mm, question: it.question, rules: COMPILE_RULES, examples, sandbox,
      labeled: train.map((t, i) => ({ text: t.text, p: labels[i][it.key].p }))
    })));
console.log(`compiled ${compiled.filter(c => c.accepted).length}/${items.length} predicates in ${Date.now() - t0} ms (rules: ${COMPILE_RULES === BASE_RULES ? "base" : "full"})`);

// 2. the stream
const inDist = Array.from({ length: N }, makeGenerator(303)).map(x => ({ ...x, phase: "in-dist" }));
const shifted = Array.from({ length: N }, makeShiftedGenerator(404)).map(x => ({ ...x, phase: "shifted" }));
const stream = [...inDist, ...shifted];

async function runStrategy(name) {
  const reg = createPredicateRegistry();
  if (name !== "all-jev") compiled.forEach((c, j) => c.accepted && reg.register(items[j].question, { code: c.code, fn: c.fn, meta: { train: c.confident } }));
  let rs = 99;
  const rnd = () => ((rs = (rs * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const m = { "in-dist": blank(), shifted: blank() };
  let firstQuarantineAfterShift = null, heals = 0, healCalls0 = mm.usage.calls;
  for (const [idx, cfg] of stream.entries()) {
    const spot = name.includes("spot") && rnd() < EPS;
    const before = new Set(reg.summary().filter(e => e.status === "quarantined").map(e => e.question));
    const trust = name.startsWith("refute-only") ? "refute-only" : "both";
    const r = name === "all-jev"
      ? await answerCompiledFirst({ registry: reg, items, text: cfg.text, state: stateOf(cfg.text), jev })
      : await answerCompiledFirst({ registry: reg, items, text: cfg.text, state: stateOf(cfg.text), jev, spotCheck: spot, trust });
    const ph = m[cfg.phase];
    ph.jevQ += r.jevQuestions;
    items.forEach((it, j) => {
      const a = r.answers[it.key];
      const truth = QUESTIONS[j][1](cfg.c);
      ph.n++;
      if ((a.p >= 0.5) === truth) ph.correct++;
      if (a.p >= 0.9 && !truth) ph.wrongGo++;
      if (a.source === "compiled") ph.compiled++; // answered by code alone, no model call
    });
    const now = reg.summary().filter(e => e.status === "quarantined");
    if (cfg.phase === "shifted" && firstQuarantineAfterShift === null && now.some(e => !before.has(e.question))) {
      firstQuarantineAfterShift = idx - N + 1;
    }
    if (name.endsWith("+heal") && now.length > before.size) {
      const h = await healQuarantined({ registry: reg, mm, rules: READING_RULES, sandbox, examples: [...examples, cfg.text], minLabels: 6 });
      heals += h.filter(x => x.healed).length;
    }
  }
  const fmt = ph => ({ acc: +(ph.correct / ph.n).toFixed(3), wrongGo: ph.wrongGo, jevQ: ph.jevQ, compiledShare: +(ph.compiled / ph.n).toFixed(2) });
  return {
    strategy: name,
    inDist: fmt(m["in-dist"]),
    shifted: fmt(m.shifted),
    quarantined: reg.summary().filter(e => e.status === "quarantined").length,
    heals,
    healMiniMaxCalls: mm.usage.calls - healCalls0,
    configsToFirstQuarantine: firstQuarantineAfterShift
  };
  function blank() { return { n: 0, correct: 0, wrongGo: 0, jevQ: 0, compiled: 0 }; }
}

const results = [];
for (const s of ["all-jev", "compiled-only", "compiled+spot", "compiled+spot+heal", "refute-only", "refute-only+spot"]) results.push(await runStrategy(s));

console.log(`\nstream: ${N} in-dist then ${N} shifted configs × ${items.length} questions; spot-check ε=${EPS}\n`);
console.log("strategy             | in-dist acc  wrongGO  jevQ  compiled | shifted acc  wrongGO  jevQ  compiled | quarantined heals  firstQ@");
for (const r of results) {
  const f = x => `${x.acc.toFixed(3).padStart(8)}  ${String(x.wrongGo).padStart(7)}  ${String(x.jevQ).padStart(4)}  ${x.compiledShare.toFixed(2).padStart(8)}`;
  console.log(`${r.strategy.padEnd(20)} | ${f(r.inDist)}    | ${f(r.shifted)}    | ${String(r.quarantined).padStart(11)} ${String(r.heals).padStart(5)}  ${String(r.configsToFirstQuarantine ?? "-").padStart(7)}`);
}
console.log(`\nusage: jev ${JSON.stringify(jev.usage)} minimax ${JSON.stringify(mm.usage)}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), EPS, N, compiled: compiled.map((c, j) => ({ q: items[j].question, accepted: c.accepted, attempts: c.attempts, confident: c.confident, code: c.code })), results }, null, 2));
