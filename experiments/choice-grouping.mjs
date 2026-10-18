#!/usr/bin/env node
/**
 * R4-B: automatic Choice-first grouping (T24, automated).
 * T24 showed "ask the field once, derive the yes/no answers" beats one Noul per question.
 * Can MiniMax find the groupings, with Jev's own Nouls as the acceptance check?
 *
 *   1. MiniMax groups the 10 Noul questions: for each field, one Choice + a mapping
 *      question → allowed options. Questions it can't map stay Nouls.
 *   2. Validate each mapping on 20 train configs against Jev's Noul answers (teacher):
 *      no confident disagreement, ≥ 10 confident agreements.
 *   3. Held-out 40 configs: accepted mappings (derived p) vs Nouls vs code truth;
 *      questions per config.
 *
 *   node experiments/choice-grouping.mjs [--out file]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax } from "../providers/minimax.mjs";
import { reliability } from "../calibration.mjs";
import { makeGenerator, QUESTIONS, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const jev = createJev();
const mm = createMiniMax();
const CONF = p => p >= 0.95 || p <= 0.05;
const stateOf = t => ({ "redis.conf": t, reading_rules: READING_RULES });

// 1. MiniMax proposes groupings
const prompt = `These yes/no questions are asked about a redis.conf file:\n${QUESTIONS.map(([q], j) => `q${j}: ${q}`).join("\n")}\n\nGroup questions that can be answered from ONE underlying setting into a single multiple-choice question about that setting. For each group give: "choice": {"instructions": "<question about the setting>", "criteria": {"<option>": "<description>", ...}} with mutually exclusive, exhaustive options (include an option for "not set" where relevant), and "derived": [{"q": "q<j>", "allowed": ["<options that mean yes>"]}]. Leave questions that need more than one setting ungrouped.\nReply with JSON {"groups": [...]}.`;
const { value } = await mm.json(prompt, { maxTokens: 8000, temperature: 0.2 });
const groups = (value.groups || []).filter(g => g?.choice?.criteria && Array.isArray(g.derived));
console.log(`MiniMax proposed ${groups.length} groups covering ${groups.reduce((a, g) => a + g.derived.length, 0)} question mappings`);
for (const g of groups) console.log(`  · "${g.choice.instructions}" options=${Object.keys(g.choice.criteria).join("|")} → ${g.derived.map(d => `${d.q}∈{${d.allowed.join(",")}}`).join("  ")}`);

async function ask(text) {
  const questions = {};
  QUESTIONS.forEach(([q], j) => { questions[`q${j}`] = { type: "noul", instructions: q }; });
  groups.forEach((g, i) => { questions[`g${i}`] = { type: "choice", instructions: g.choice.instructions, criteria: g.choice.criteria }; });
  const d = await jev.ask(stateOf(text), questions);
  const derived = {};
  groups.forEach((g, i) => {
    const probs = d.answers[`g${i}`]?.probabilities || {};
    // first group wins if two map the same question (grouping.mjs validates each mapping separately)
    for (const m of g.derived) if (!(m.q in derived)) derived[m.q] = Math.min(1, (m.allowed || []).reduce((s, o) => s + (Number(probs[o]) || 0), 0));
  });
  return { noul: Object.fromEntries(QUESTIONS.map((_, j) => [`q${j}`, d.answers[`q${j}`].noul])), derived };
}

// 2. validation against Jev's Nouls on train
const train = Array.from({ length: 20 }, makeGenerator(101));
const trainAns = await Promise.all(train.map(t => ask(t.text)));
const accepted = {};
for (const j of QUESTIONS.keys()) {
  const k = `q${j}`;
  if (!(k in trainAns[0].derived)) continue;
  let agree = 0, disagree = 0;
  for (const a of trainAns) {
    const pn = a.noul[k], pd = a.derived[k];
    if (!CONF(pn) || !CONF(pd)) continue;
    if ((pn >= 0.5) === (pd >= 0.5)) agree++; else disagree++;
  }
  accepted[k] = { agree, disagree, ok: disagree === 0 && agree >= 10 };
}
console.log(`\nvalidation: ${Object.entries(accepted).map(([k, v]) => `${k}:${v.ok ? "accept" : "reject"}(${v.agree}/${v.disagree})`).join(" ")}`);

// 3. held-out test
const test = Array.from({ length: 40 }, makeGenerator(202));
const testAns = await Promise.all(test.map(t => ask(t.text)));
const rows = { noul: [], derivedAccepted: [], nouls_same_questions: [] };
const perQ = {};
for (const [i, t] of test.entries()) {
  QUESTIONS.forEach(([, f], j) => {
    const k = `q${j}`, truth = f(t.c);
    rows.noul.push({ p: testAns[i].noul[k], truth });
    if (accepted[k]?.ok) {
      rows.derivedAccepted.push({ p: testAns[i].derived[k], truth });
      rows.nouls_same_questions.push({ p: testAns[i].noul[k], truth });
      (perQ[k] ||= { derived: [], noul: [] });
      perQ[k].derived.push({ p: testAns[i].derived[k], truth });
      perQ[k].noul.push({ p: testAns[i].noul[k], truth });
    }
  });
}
const fmt = m => `brier ${m.brier.toFixed(4)}  ECE ${m.ece.toFixed(4)}  GO@0.9 ${m.gate[0.9].go} wrong ${m.gate[0.9].wrongGo} recall ${m.gate[0.9].recall.toFixed(3)}`;
const acceptedQs = Object.keys(accepted).filter(k => accepted[k].ok);
const choicesNeeded = groups.filter(g => g.derived.some(d => accepted[d.q]?.ok)).length;
console.log(`\nheld-out (40 configs) on the ${acceptedQs.length} accepted questions:`);
console.log(`  derived from Choice: ${fmt(reliability(rows.derivedAccepted))}`);
console.log(`  one Noul each:       ${fmt(reliability(rows.nouls_same_questions))}`);
for (const [k, v] of Object.entries(perQ)) console.log(`    ${k}  derived ${fmt(reliability(v.derived))}   noul ${fmt(reliability(v.noul))}`);
console.log(`\nquestions per config: all Nouls ${QUESTIONS.length}  →  grouped ${choicesNeeded} choices + ${QUESTIONS.length - acceptedQs.length} remaining Nouls = ${choicesNeeded + QUESTIONS.length - acceptedQs.length}`);
console.log(`usage: jev ${JSON.stringify(jev.usage)} minimax ${JSON.stringify(mm.usage)}`);
if (args.includes("--out")) fs.writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify({ at: new Date().toISOString(), groups, accepted, derived: reliability(rows.derivedAccepted), nouls: reliability(rows.nouls_same_questions), choicesNeeded, acceptedQs }, null, 2));
