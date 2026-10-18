import { test } from "node:test";
import assert from "node:assert/strict";
import { JEVLattice } from "../jev-core.js";
import { memoryStore } from "../proof-cache.mjs";
import { createLabelBank, learnThreshold, teach, senseReport } from "../senses.mjs";

test("learnThreshold finds the lowest bar with no wrong GOs, or refuses", () => {
  const s = [[0.99, true], [0.95, true], [0.95, false], [0.999, true], [0.2, false], [0.1, false], [1, true], [0.97, true]];
  assert.deepEqual(learnThreshold(s, { minSamples: 5, minGo: 2 }).t, 0.96);
  assert.equal(learnThreshold(s.slice(0, 3), { minSamples: 5 }).t, null, "too few samples");
  assert.equal(learnThreshold([[1, false], [1, true], [1, true], [0, false], [0, false]], { minSamples: 3 }).t, null, "a confident wrong 1.0 is never safe");
});

test("teach labels only decided gates and banks every sense's reading", async () => {
  const L = new JEVLattice();
  const go = L.ingest({ text: "Is TLS on?", question_spec: { confidence_threshold: 0.9 }, proof: { source_type: "JEV_NOUL", confidence: 0.98 }, linkToNearest: false }).node;
  const no = L.ingest({ text: "Is AOF on?", question_spec: { confidence_threshold: 0.9 }, proof: { source_type: "JEV_NOUL", confidence: 0.02 }, linkToNearest: false }).node;
  const open = L.ingest({ text: "Is it fast?", question_spec: { confidence_threshold: 0.9 }, proof: { source_type: "JEV_NOUL", confidence: 0.5 }, linkToNearest: false }).node;
  const bank = createLabelBank(memoryStore());
  const senses = {
    loud: async () => 1,                                  // always says yes
    batchy: { batch: async items => items.map(it => (it.question.includes("TLS") ? 0.9 : 0.1)) }
  };
  const r = await teach(L, { ids: [go.id, no.id, open.id], files: {}, senses, bank });
  assert.equal(r.labelled, 2, "OPEN gates teach nothing");
  assert.equal(r.senses.loud.banked, 2);
  assert.deepEqual((await bank.get("Is AOF on?", "loud")).samples, [[1, false]]);
  for (let i = 0; i < 4; i++) await teach(L, { ids: [go.id, no.id], files: {}, senses, bank });
  const rep = await senseReport(L, { ids: [go.id, no.id], senseNames: ["loud", "batchy"], bank, minSamples: 5, minGo: 3 });
  const row = (q, s) => rep.rows.find(x => x.question === q && x.sense === s);
  assert.equal(row("Is TLS on?", "batchy").learned.t, 0.5);
  assert.equal(row("Is AOF on?", "loud").learned.t, null, "loud is never safe on AOF");
  assert.equal(row("Is AOF on?", "loud").acc, 0);
});

test("earned discount: a small clean bank cannot drop the bar below the floor", () => {
  const s = [...Array.from({ length: 6 }, () => [0.6, true]), ...Array.from({ length: 6 }, () => [0.1, false])];
  assert.equal(learnThreshold(s, { minSamples: 5 }).t, 0.5);
  const capped = learnThreshold(s, { minSamples: 5, floor: 0.9, minGoForDiscount: 30 });
  assert.equal(capped.t, 0.9);
  assert.equal(capped.capped, true);
  const many = [...Array.from({ length: 40 }, () => [0.6, true]), [0.1, false]];
  assert.equal(learnThreshold(many, { minSamples: 5, floor: 0.9, minGoForDiscount: 30 }).t, 0.5, "40 clean GOs earn the discount");
});

test("tolerance treats a small share of GO-side 'no' labels as teacher noise", () => {
  const s = [...Array.from({ length: 49 }, () => [0.97, true]), [0.97, false], ...Array.from({ length: 20 }, () => [0.1, false])];
  assert.equal(learnThreshold(s, { minSamples: 5 }).t, null, "strict: the single flipped label blocks every bar ≤ 0.97");
  assert.equal(learnThreshold(s, { minSamples: 5, tolerance: 0.03 }).t, 0.5);
});

test("allowedDisagreements / teacherErrorRate / learnThreshold with a teacher error rate", async () => {
  const { allowedDisagreements, teacherErrorRate, learnThreshold } = await import("../senses.mjs");
  assert.equal(allowedDisagreements(100, 0), 0);
  assert.equal(allowedDisagreements(10, 0.02), 1, "P(Bin(10,.02) > 0) ≈ 0.18 > 0.05, P(>1) ≈ 0.016");
  assert.ok(allowedDisagreements(200, 0.05) >= 14 && allowedDisagreements(200, 0.05) <= 16);
  const r = teacherErrorRate([[true, true], [false, true], [true, true], [null, false]]);
  assert.equal(r.n, 3); assert.equal(r.errors, 1);
  assert.equal(teacherErrorRate([[true, true]]).rate, 0);
  // 40 student GOs at p≥0.9, one teacher "no" among them (noise): strict blocks, ε=2% forgives
  const samples = [...Array.from({ length: 39 }, () => [0.95, true]), [0.95, false], ...Array.from({ length: 20 }, () => [0.2, false])];
  assert.ok(learnThreshold(samples).t === null || learnThreshold(samples).t > 0.95);
  assert.equal(learnThreshold(samples, { teacherErrorRate: 0.02 }).t, 0.5);
  assert.equal(learnThreshold(samples, { teacherErrorRate: 0 }).t, learnThreshold(samples).t, "ε = 0 is the strict policy");
});
