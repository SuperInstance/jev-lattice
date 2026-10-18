#!/usr/bin/env node
/**
 * R4-D: metamorphic validation of compiled predicates.
 *
 * Round 2–3: predicates that passed validation on 20 configs still produced wrong GOs,
 * in distribution and after a format shift. Can we catch brittle code BEFORE it ships
 * by also validating on meaning-preserving rewrites of the training inputs?
 *
 *   1. MiniMax writes ONE candidate predicate per question (base reading rules, 1 attempt).
 *   2. MiniMax rewrites each training config preserving meaning, using whatever syntax
 *      Redis allows. It is NOT told what the later shift looks like.
 *   3. Jev labels originals and rewrites. A rewrite is kept only if Jev's confident answers
 *      match the original's (meaning-preservation check, no ground truth used).
 *   4. Same candidates, two acceptance tests:  plain (originals)  vs  metamorphic (originals + rewrites).
 *   5. Score the accepted sets on a stream: 30 in-distribution configs, then 30 shifted ones.
 *
 *   node experiments/metamorphic.mjs [--runs 2] [--rewrites 2] [--out file]
 */
import vm from "node:vm";
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, extractJson } from "../providers/minimax.mjs";
import { makeGenerator, makeShiftedGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt("--runs", 2)), REWRITES = Number(opt("--rewrites", 2));
const BASE_RULES = "later directives override earlier ones; lines starting with # are comments.";
const CONF = p => p >= 0.95 || p <= 0.05;

/** node:vm is NOT a sandbox — local R&D only. */
function sandbox(src) {
  const ctx = vm.createContext(Object.create(null));
  const fn = vm.runInContext(`(${src})`, ctx, { timeout: 50 });
  if (typeof fn !== "function") throw new Error("not a function");
  ctx.__fn = fn;
  return text => { ctx.__t = text; return vm.runInContext("__fn(__t)", ctx, { timeout: 50 }) === true; };
}
const safe = (fn, t) => { try { return fn(t); } catch { return "threw"; } };

const jev = createJev();
const mm = createMiniMax(); // default: MiniMax-M3.1-Flash-Preview
const items = QUESTIONS.map(([q], j) => ({ key: `q${j}`, instructions: q }));
const label = async text => {
  const a = await jev.nouls({ "redis.conf": text, reading_rules: READING_RULES }, items);
  return items.map(it => a[it.key].p);
};

const train = Array.from({ length: 20 }, makeGenerator(101));
const trainLabels = await Promise.all(train.map(t => label(t.text)));

// 2–3. meaning-preserving rewrites, checked by Jev agreement
const t0 = Date.now();
const rewrites = [];
let proposed = 0, dropped = 0;
await Promise.all(train.map(async (t, i) => {
  try {
    const { value } = await mm.json(`Here is a Redis configuration file:\n${t.text}\n\nWrite ${REWRITES} different versions of this file that configure Redis EXACTLY the same way (identical effective settings), but are written differently, using any syntactic variation the Redis config format allows. Do not add or remove effective settings.\nReply with JSON {"versions": ["...", "..."]}.`, { maxTokens: 6000, temperature: 0.8 });
    for (const text of (value.versions || []).slice(0, REWRITES)) {
      proposed++;
      const ls = await label(String(text));
      // keep only if every question that is confident on BOTH sides agrees
      const consistent = ls.every((p, j) => !(CONF(p) && CONF(trainLabels[i][j])) || (p >= 0.5) === (trainLabels[i][j] >= 0.5));
      if (consistent) rewrites.push({ text: String(text), labels: ls, of: i });
      else dropped++;
    }
  } catch { /* a failed rewrite just contributes nothing */ }
}));
console.log(`rewrites: ${proposed} proposed, ${rewrites.length} kept, ${dropped} dropped by the Jev meaning check (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

// stream for scoring
const stream = [
  ...Array.from({ length: 30 }, makeGenerator(303)).map(x => ({ ...x, phase: "in-dist" })),
  ...Array.from({ length: 30 }, makeShiftedGenerator(404)).map(x => ({ ...x, phase: "shifted" }))
];

function accept(fn, j, set) {
  let confident = 0;
  for (const { text, p } of set(j)) {
    if (!CONF(p)) continue;
    confident++;
    if (safe(fn, text) !== p >= 0.95) return { ok: false, confident };
  }
  return { ok: confident >= 10, confident };
}
const plainSet = j => train.map((t, i) => ({ text: t.text, p: trainLabels[i][j] }));
const metaSet = j => [...plainSet(j), ...rewrites.map(r => ({ text: r.text, p: r.labels[j] }))];

const results = [];
for (let run = 0; run < RUNS; run++) {
  const examples = train.slice(0, 3).map(t => t.text).join("\n-----\n");
  const cands = await Promise.all(QUESTIONS.map(async ([q]) => {
    try {
      const out = await mm.chat(`Write a pure JavaScript arrow function \`(text) => boolean\` answering this yes/no question about a redis.conf file:\n"${q}"\nReading rules: ${BASE_RULES}\nUse only string/regex/array methods; no require, no globals, no I/O.\nExample files:\n${examples}\nReply with JSON {"code": "<the arrow function source>"}.`, { maxTokens: 8000, temperature: 0.2 });
      const code = extractJson(out.text).code;
      return { code, fn: sandbox(code) };
    } catch (e) { return { error: e.message }; }
  }));
  const policy = {};
  for (const [name, set] of [["plain", plainSet], ["metamorphic", metaSet]]) {
    const acc = cands.map((c, j) => (c.fn ? accept(c.fn, j, set) : { ok: false }));
    const m = { "in-dist": { n: 0, wrongGo: 0, wrongNo: 0 }, shifted: { n: 0, wrongGo: 0, wrongNo: 0 } };
    for (const cfg of stream) {
      cands.forEach((c, j) => {
        if (!acc[j].ok) return; // rejected predicates never answer
        const got = safe(c.fn, cfg.text), truth = QUESTIONS[j][1](cfg.c), ph = m[cfg.phase];
        ph.n++;
        if (got === true && !truth) ph.wrongGo++;
        if (got !== true && truth) ph.wrongNo++;
      });
    }
    policy[name] = { accepted: acc.filter(a => a.ok).length, acceptedQs: acc.map((a, j) => (a.ok ? j : null)).filter(x => x !== null), ...m };
  }
  results.push({ run, compiled: cands.filter(c => c.fn).length, policy });
  console.log(`\nrun ${run}: ${cands.filter(c => c.fn).length}/10 candidates compiled`);
  for (const [name, p] of Object.entries(policy)) {
    console.log(`  ${name.padEnd(11)} accepted ${p.accepted}/10 ${JSON.stringify(p.acceptedQs)}  in-dist wrongGO ${p["in-dist"].wrongGo} wrongNO ${p["in-dist"].wrongNo} (n=${p["in-dist"].n})  shifted wrongGO ${p.shifted.wrongGo} wrongNO ${p.shifted.wrongNo} (n=${p.shifted.n})`);
  }
}
console.log(`\nusage: jev ${JSON.stringify(jev.usage)} minimax ${JSON.stringify(mm.usage)}`);
const out = opt("--out", null);
if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), RUNS, REWRITES, rewritesKept: rewrites.length, proposed, dropped, sampleRewrites: rewrites.slice(0, 3).map(r => r.text), results }, null, 2));
