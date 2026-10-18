#!/usr/bin/env node
/**
 * R3-A: Terraform plans at scale — where does reading the whole state stop working?
 * Generator: experiments/tf-gen.mjs (written by MiniMax, validated by tf-gen-check.mjs).
 *
 *   whole       one Jev call over the whole plan JSON (default 32k/question context)
 *   whole-long  same, with the long-context header (262k)
 *   sliced      "decompose the state, not the question": slices of SLICE resources, one call
 *               per slice; per-slice answers composed by probability rules —
 *                 any:   P = 1 − Π(1 − p_i)        all: P = Π p_i
 *                 count: per-slice Choice over counts, convolved → P(total > 3)
 *
 *   node experiments/terraform-scale.mjs [--sizes 10,30,100,300] [--plans 16] [--slice 20]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { makeTfGenerator, TF_QUESTIONS } from "./tf-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SIZES = opt("--sizes", "10,30,100,300").split(",").map(Number);
const PLANS = Number(opt("--plans", 16)), SLICE = Number(opt("--slice", 20));
const LONG = args.includes("--long");
const T = 0.9;
const KIND = ["any", "any", "all", "any", "any", "all", "count"];
const SLICE_Q = [
  "Will any resource in this slice be destroyed (a delete action, including replacements)?",
  "Does any security group in this slice allow inbound SSH (port 22) from 0.0.0.0/0?",
  "Does every resource in this slice have both an env tag and an owner tag after the change?",
  "Is any S3 bucket in this slice public-read after the change?",
  "Does any IAM policy in this slice grant Action * on Resource *?",
  "Do all database instances in this slice have deletion_protection enabled (true if the slice has none)?",
  null
];
const COUNT_OPTS = ["0", "1", "2", "3", "4", "5", "6+"];

const jev = createJev();
const jevLong = createJev({ longContext: true });
const verdict = p => (p >= T ? "GO" : p <= 1 - T ? "REFUTED" : "OPEN");

function convolveOver3(dists) {
  // dists: array of {k: prob} over counts 0..6 (6 = 6+); P(sum > 3)
  let acc = [1];
  for (const d of dists) {
    const next = new Array(acc.length + 6).fill(0);
    acc.forEach((a, i) => COUNT_OPTS.forEach((o, k) => { next[i + k] += a * (d[o] || 0); }));
    acc = next;
  }
  return acc.slice(4).reduce((x, y) => x + y, 0);
}

async function wholeArm(client, plan) {
  try {
    const ans = await client.nouls({ plan }, TF_QUESTIONS.map(([q], j) => ({ key: `q${j}`, instructions: q })));
    return TF_QUESTIONS.map((_, j) => ans[`q${j}`].p);
  } catch (e) {
    return { error: e.status || e.message.slice(0, 60) };
  }
}

async function slicedArm(plan) {
  const rs = plan.resource_changes;
  const slices = [];
  for (let i = 0; i < rs.length; i += SLICE) slices.push(rs.slice(i, i + SLICE));
  const per = await Promise.all(slices.map(async sl => {
    const questions = {};
    SLICE_Q.forEach((q, j) => { if (q) questions[`q${j}`] = { type: "noul", instructions: q }; });
    questions.count = { type: "choice", instructions: "How many resources in this slice are being created (actions include create)?", criteria: Object.fromEntries(COUNT_OPTS.map(o => [o, null])) };
    const d = await jev.ask({ plan_slice: { format_version: plan.format_version, resource_changes: sl } }, questions);
    return d.answers;
  }));
  const prob = KIND.map((kind, j) => {
    if (kind === "count") return convolveOver3(per.map(a => a.count.probabilities));
    const ps = per.map(a => a[`q${j}`].noul);
    return kind === "any" ? 1 - ps.reduce((x, p) => x * (1 - p), 1) : ps.reduce((x, p) => x * p, 1);
  });
  // Verdict lifting: quantifiers over slice VERDICTS (deterministic), not products of probabilities.
  //   any: GO if some slice GO; REFUTED only if every slice REFUTED       all: the dual
  const lifted = KIND.map((kind, j) => {
    if (kind === "count") return prob[j];
    const vs = per.map(a => verdict(a[`q${j}`].noul));
    const [win, lose] = kind === "any" ? ["GO", "REFUTED"] : ["REFUTED", "GO"];
    if (vs.includes(win)) return win === "GO" ? 1 : 0;
    if (vs.every(v => v === lose)) return lose === "GO" ? 1 : 0;
    return 0.5;
  });
  return { prob, lifted };
}

const report = {};
for (const n of SIZES) {
  const g = makeTfGenerator(1000 + n);
  const plans = Array.from({ length: PLANS }, () => g(n));
  const approxTokens = Math.round(JSON.stringify(plans[0].plan).length / 3.5);
  const arms = { whole: [], ...(LONG ? { "whole-long": [] } : {}), "sliced-prob": [], "sliced-lift": [] };
  await Promise.all(plans.map(async ({ plan, truth }) => {
    const truths = TF_QUESTIONS.map(([, f]) => f(truth));
    const [w, wl, sl] = await Promise.all([wholeArm(jev, plan), LONG ? wholeArm(jevLong, plan) : null, slicedArm(plan)]);
    arms.whole.push({ ps: w, truths });
    if (LONG) arms["whole-long"].push({ ps: wl, truths });
    arms["sliced-prob"].push({ ps: sl.prob, truths });
    arms["sliced-lift"].push({ ps: sl.lifted, truths });
  }));
  report[n] = { approxTokens };
  console.log(`\nn=${n} resources (~${approxTokens} tokens of state), ${PLANS} plans × ${TF_QUESTIONS.length} questions`);
  for (const [name, rows] of Object.entries(arms)) {
    const errs = rows.filter(r => !Array.isArray(r.ps));
    const ok = rows.filter(r => Array.isArray(r.ps));
    const byQ = TF_QUESTIONS.map(() => ({ correct: 0, open: 0, wrongGo: 0, wrongRef: 0 }));
    for (const r of ok) r.ps.forEach((p, j) => {
      const v = verdict(p), t = r.truths[j], b = byQ[j];
      if (v === "OPEN") b.open++;
      else if ((v === "GO") === t) b.correct++;
      else if (v === "GO") b.wrongGo++;
      else b.wrongRef++;
    });
    const tot = byQ.reduce((a, b) => ({ correct: a.correct + b.correct, open: a.open + b.open, wrongGo: a.wrongGo + b.wrongGo, wrongRef: a.wrongRef + b.wrongRef }), { correct: 0, open: 0, wrongGo: 0, wrongRef: 0 });
    const cases = ok.length * TF_QUESTIONS.length || 1;
    report[n][name] = { errors: errs.length, errorSample: errs[0]?.ps?.error, ...tot, cases, perQuestion: byQ };
    console.log(`  ${name.padEnd(10)} ${errs.length ? `request errors ${errs.length} (${errs[0].ps.error})  ` : ""}correct ${(tot.correct / cases).toFixed(3)}  open ${(tot.open / cases).toFixed(3)}  wrongGO ${tot.wrongGo}  wrongREF ${tot.wrongRef}   per-q correct: ${byQ.map(b => (ok.length ? b.correct / ok.length : 0).toFixed(2)).join(" ")}`);
  }
}
console.log(`\njev usage: default ${JSON.stringify(jev.usage)} long ${JSON.stringify(jevLong.usage)}`);
if (args.includes("--out")) fs.writeFileSync(opt("--out"), JSON.stringify({ at: new Date().toISOString(), SIZES, PLANS, SLICE, report }, null, 2));
