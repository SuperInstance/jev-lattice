#!/usr/bin/env node
/**
 * Verifier calibration bench — which proof sources deserve which threshold?
 *
 * Ground truth comes from code, not from a model: we generate random
 * redis.conf files (with traps: commented-out lines, overridden directives)
 * and yes/no questions whose answers a deterministic parser computes.
 *
 *   node experiments/calibration.mjs [--n 12] [--worker https://… --key …] [--no-minimax]
 *
 * Reports per source: accuracy@0.5, Brier score, ECE, and "safe GO rate":
 * at threshold t, how many GO decisions were wrong (the number a gate cares about).
 */
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, MINIMAX_FAST_MODEL } from "../providers/minimax.mjs";
import fs from "node:fs";
import { makeGenerator, QUESTIONS } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt("--n", 12));
const WORKER = opt("--worker", null);
const KEY = opt("--key", process.env.JEV_API_KEY);
const useMM = !args.includes("--no-minimax");
const OUT = opt("--out", null);

const RULES = "later directives override earlier ones; lines starting with # are comments.";
const JEV_RULES = !args.includes("--jev-no-rules");

const genConfig = makeGenerator(Number(opt("--seed", 7)));

const items = [];
for (let i = 0; i < N; i++) {
  const { c, text } = genConfig();
  items.push({ cfg: i, text, qs: QUESTIONS.map(([q, f], j) => ({ key: `q${j}`, q, truth: f(c) })) });
}
const total = items.length * QUESTIONS.length;
console.log(`${items.length} configs × ${QUESTIONS.length} questions = ${total} labeled cases`);

// ---------- sources ----------
// source -> Map("cfg:key" -> {p, truth}); keyed so async completion order can't misalign rows
const results = {};
const record = (src, cfg, key, p, truth) => (results[src] ||= new Map()).set(`${cfg}:${key}`, { p, truth });

const jev = createJev();
let t0 = Date.now();
await Promise.all(items.map(async it => {
  // same reading rules every judge gets (fairness: the LLM prompts carry them too)
  const state = JEV_RULES ? { "redis.conf": it.text, reading_rules: RULES } : { "redis.conf": it.text };
  const ans = await jev.nouls(state, it.qs.map(x => ({ key: x.key, instructions: x.q })));
  for (const x of it.qs) record("jev", it.cfg, x.key, ans[x.key].p, x.truth);
}));
console.log(`jev: ${items.length} fan-out calls in ${Date.now() - t0} ms, usage=${JSON.stringify(jev.usage)}`);

async function pool(tasks, n) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k]().catch(e => ({ error: e.message })); }
  }));
  return out;
}

const judgePrompt = (cfg, q) => `redis.conf:\n${cfg}\n\nQuestion: ${q}\nRemember: ${RULES}\nReply with JSON {"probability_yes": number 0..1}. Be calibrated.`;

if (useMM) {
  const mm = createMiniMax({ model: opt("--mm-model", MINIMAX_FAST_MODEL) });
  t0 = Date.now();
  // one call per config answering all questions (MiniMax's own fan-out)
  await pool(items.map(it => async () => {
    const prompt = `redis.conf:\n${it.text}\n\nRemember: ${RULES}\nFor each question give the probability the answer is yes. Be calibrated.\n${it.qs.map(x => `${x.key}: ${x.q}`).join("\n")}\n\nReply with JSON {"q0": p, "q1": p, ...}.`;
    const { value } = await mm.json(prompt, { maxTokens: 8000, temperature: 0 });
    for (const x of it.qs) {
      const p = Number(value[x.key]);
      if (Number.isFinite(p)) record("minimax", it.cfg, x.key, Math.max(0, Math.min(1, p)), x.truth);
    }
  }), 6);
  console.log(`minimax (${mm.model}): ${Date.now() - t0} ms, usage=${JSON.stringify(mm.usage)}`);
}

if (WORKER) {
  t0 = Date.now();
  const lattice = `calib-${Date.now().toString(36)}`;
  const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const tool = async (name, a) => (await fetch(`${WORKER}/api/${lattice}/tool/${name}`, { method: "POST", headers: H, body: JSON.stringify(a) })).json();
  const cases = items.flatMap(it => it.qs.map(x => ({ it, x })));
  await pool(cases.map(({ it, x }) => async () => {
    const q = await tool("jev_ingest", { text: x.q, question_spec: { confidence_threshold: 0.9 }, linkToNearest: false });
    const r = await tool("jev_edge_proof", { id: q.node.id, state: judgePrompt(it.text, x.q) });
    if (r.ok) record("workers-ai", it.cfg, x.key, r.p, x.truth);
  }), 8);
  console.log(`workers-ai via ${WORKER}: ${Date.now() - t0} ms`);
}

// ---------- metrics ----------
function metrics(rows) {
  const n = rows.length;
  const acc = rows.filter(r => (r.p >= 0.5) === r.truth).length / n;
  const brier = rows.reduce((s, r) => s + (r.p - (r.truth ? 1 : 0)) ** 2, 0) / n;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const r of rows) {
    const b = bins[Math.min(9, Math.floor(r.p * 10))];
    b.n++; b.p += r.p; b.y += r.truth ? 1 : 0;
  }
  const ece = bins.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  const gate = {};
  for (const t of [0.8, 0.9, 0.95]) {
    const go = rows.filter(r => r.p >= t);
    gate[t] = { go: go.length, wrongGo: go.filter(r => !r.truth).length };
  }
  return { n, acc: +acc.toFixed(3), brier: +brier.toFixed(3), ece: +ece.toFixed(3), gate };
}

const report = {};
console.log("\nsource        n    acc@.5  brier   ECE    | GO@0.8 (wrong)  GO@0.9 (wrong)  GO@0.95 (wrong)");
for (const [src, map] of Object.entries(results)) {
  const m = (report[src] = metrics([...map.values()]));
  const g = t => `${String(m.gate[t].go).padStart(4)} (${m.gate[t].wrongGo})`.padEnd(15);
  console.log(`${src.padEnd(12)} ${String(m.n).padStart(4)}  ${m.acc.toFixed(3)}   ${m.brier.toFixed(3)}   ${m.ece.toFixed(3)}  | ${g(0.8)} ${g(0.9)} ${g(0.95)}`);
}

// Coordinated gate: GO only if two independent sources both ≥ t — does pairing kill wrong GOs?
const srcs = Object.keys(results);
for (let a = 0; a < srcs.length; a++) for (let b = a + 1; b < srcs.length; b++) {
  const t = 0.9;
  const shared = [...results[srcs[a]].keys()].filter(k => results[srcs[b]].has(k));
  const rows = shared.map(k => ({ A: results[srcs[a]].get(k), B: results[srcs[b]].get(k) }));
  const go = rows.filter(r => r.A.p >= t && r.B.p >= t);
  const wrong = go.filter(r => !r.A.truth).length;
  const right = go.length - wrong;
  const truths = rows.filter(r => r.A.truth).length;
  console.log(`COORDINATED(${srcs[a]}+${srcs[b]}) @0.9: GO ${right + wrong}, wrong ${wrong}, recall ${(right / truths).toFixed(3)}`);
  report[`${srcs[a]}+${srcs[b]}`] = { go: right + wrong, wrong, recall: +(right / truths).toFixed(3) };
}

// Per-question accuracy for Jev — where is it jagged?
const perQ = QUESTIONS.map(([q], j) => {
  const rows = items.map(it => results.jev.get(`${it.cfg}:q${j}`));
  return { q, acc: rows.filter(r => (r.p >= 0.5) === r.truth).length / rows.length };
});
console.log("\njev per-question accuracy:");
for (const x of perQ) console.log(`  ${x.acc.toFixed(2)}  ${x.q}`);
report.jev_per_question = perQ;

// Per-question accuracy for every source, to see who is jagged where
for (const src of srcs.filter(x => x !== "jev")) {
  report[`${src}_per_question`] = QUESTIONS.map(([q], j) => {
    const rows = items.map(it => results[src].get(`${it.cfg}:q${j}`)).filter(Boolean);
    return { q, acc: rows.filter(r => (r.p >= 0.5) === r.truth).length / (rows.length || 1) };
  });
}

// --rows file: raw (source, cfg, question, p, truth) rows for fitting calibration maps
const ROWS = opt("--rows", null);
if (ROWS) {
  const rows = [];
  for (const [src, map] of Object.entries(results)) for (const [k, v] of map) rows.push({ source: src, case: k, q: Number(k.split(":q")[1]), ...v });
  fs.writeFileSync(ROWS, JSON.stringify(rows));
}

if (OUT) fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), n: total, report }, null, 2));
