#!/usr/bin/env node
/**
 * Progressive compilation, literally: turn model judgement into code.
 *
 *   1. MiniMax writes a JS predicate `(configText) => boolean` per question   (discovery, expensive, once)
 *   2. Jev labels a TRAIN set; we keep only answers with p ≥ 0.95 or ≤ 0.05   (teacher, cheap, no human labels)
 *   3. The predicate must agree with every confident Jev label to be accepted (self-verification)
 *   4. Accepted predicates are scored on a held-out TEST set against code ground truth
 *   5. Accepted predicates become DETERMINISTIC_PARSER proofs (cost 0.01, ~µs) in a lattice
 *
 *   node experiments/compile-parser.mjs [--train 20] [--test 40]
 *
 * NOTE: node:vm is NOT a security boundary. Generated code runs with a timeout in a
 * bare context with no globals; fine for R&D on your own machine, not for untrusted input.
 */
import vm from "node:vm";
import { JEVLattice } from "../jev-core.js";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, MINIMAX_FAST_MODEL, extractJson } from "../providers/minimax.mjs";
import { makeGenerator, QUESTIONS } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const TRAIN = opt("--train", 20), TEST = opt("--test", 40);
const RULES = "later directives override earlier ones; lines starting with # are comments.";

const jev = createJev();
const mm = createMiniMax({ model: MINIMAX_FAST_MODEL });
const train = Array.from({ length: TRAIN }, makeGenerator(101));
const test = Array.from({ length: TEST }, makeGenerator(202));

// 2. Jev labels train set (one fan-out call per config)
const labels = await Promise.all(train.map(async t => {
  const a = await jev.nouls({ "redis.conf": t.text, reading_rules: RULES }, QUESTIONS.map(([q], j) => ({ key: `q${j}`, instructions: q })));
  return QUESTIONS.map((_, j) => a[`q${j}`].p);
}));

function compilePredicate(src) {
  const ctx = vm.createContext(Object.create(null));
  const fn = vm.runInContext(`(${src})`, ctx, { timeout: 50 });
  if (typeof fn !== "function") throw new Error("not a function");
  return text => {
    ctx.__t = text;
    return vm.runInContext("__fn(__t)", Object.assign(ctx, { __fn: fn }), { timeout: 50 }) === true;
  };
}

const sample = train.slice(0, 3).map(t => t.text).join("\n-----\n");
const compiled = [];
const tStart = Date.now();
await Promise.all(QUESTIONS.map(async ([q, truthFn], j) => {
  const row = { q, accepted: false };
  let feedback = "";
  for (let attempt = 1; attempt <= 2 && !row.accepted; attempt++) {
    const out = await mm.chat(`Write a pure JavaScript arrow function \`(text) => boolean\` answering this yes/no question about a redis.conf file:
"${q}"
Rules: ${RULES} Use only string/regex/array methods; no require, no globals, no I/O.
Example files:
${sample}
${feedback}
Reply with JSON {"code": "<the arrow function source>"}.`, { maxTokens: 6000, temperature: 0 });
    let pred;
    try {
      pred = compilePredicate(extractJson(out.text).code);
    } catch (e) {
      feedback = `Your previous answer failed to compile: ${e.message}`;
      continue;
    }
    // 3. self-verification against confident teacher labels only
    const disagreements = [];
    let confident = 0;
    train.forEach((t, i) => {
      const p = labels[i][j];
      if (p > 0.05 && p < 0.95) return;
      confident++;
      let got;
      try { got = pred(t.text); } catch { got = "threw"; }
      if (got !== p >= 0.95) disagreements.push({ text: t.text, teacher: p >= 0.95, got });
    });
    row.attempts = attempt;
    row.confidentLabels = confident;
    row.trainDisagreements = disagreements.length;
    if (disagreements.length === 0 && confident >= TRAIN / 2) {
      row.accepted = true;
      // 4. held-out evaluation against code ground truth
      const t0 = process.hrtime.bigint();
      const right = test.filter(t => { try { return pred(t.text) === truthFn(t.c); } catch { return false; } }).length;
      row.testAcc = right / test.length;
      row.usPerCall = Number(process.hrtime.bigint() - t0) / 1000 / test.length;
      row.pred = pred;
    } else {
      const d = disagreements[0];
      feedback = d
        ? `Your previous function returned ${d.got} but the correct answer is ${d.teacher} for:\n${d.text}`
        : "Too few confident labels to validate; make the function robust anyway.";
    }
  }
  compiled[j] = row;
}));

console.log(`compiled ${QUESTIONS.length} questions in ${Date.now() - tStart} ms (MiniMax ${mm.usage.calls} calls, Jev ${jev.usage.calls} calls)\n`);
console.log("accepted  tries  conf  trainΔ  testAcc  µs/call  question");
for (const r of compiled) {
  console.log(`${String(r.accepted).padEnd(8)}  ${String(r.attempts ?? "-").padEnd(5)}  ${String(r.confidentLabels ?? "-").padEnd(4)}  ${String(r.trainDisagreements ?? "-").padEnd(6)}  ${r.testAcc !== undefined ? r.testAcc.toFixed(3) : "  -  "}    ${r.usPerCall !== undefined ? r.usPerCall.toFixed(1).padStart(6) : "     -"}  ${r.q}`);
}

// 5. compiled parsers as proofs: the steady state needs no model at all
const L = new JEVLattice();
const cfg = test[0];
for (const [j, r] of compiled.entries()) {
  if (!r.accepted) continue;
  const n = L.ingest({ text: r.q, question_spec: { confidence_threshold: 0.9 }, linkToNearest: false }).node;
  const yes = r.pred(cfg.text);
  L.addProof(n.id, { source_type: "DETERMINISTIC_PARSER", provider: "compiled-minimax", confidence: yes ? 0.99 : 0.01, cost_weight: 0.01, note: `compiled predicate, train-verified against Jev` });
  const truth = QUESTIONS[j][1](cfg.c);
  console.log(`  ${L.evaluateGoNoGo(n.id).verdict.padEnd(8)} (truth ${truth ? "yes" : "no "})  ${r.q}`);
}
