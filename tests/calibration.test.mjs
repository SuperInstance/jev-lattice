import { test } from "node:test";
import assert from "node:assert/strict";
import { fitIsotonic, calibrate, calibrateProof, reliability } from "../calibration.mjs";

test("isotonic fit pulls an overconfident source down to its empirical accuracy", () => {
  // says 1.0 every time but is right 80% of the time; says 0 and is right 90%
  const rows = [
    ...Array.from({ length: 80 }, () => ({ p: 1, truth: true })),
    ...Array.from({ length: 20 }, () => ({ p: 1, truth: false })),
    ...Array.from({ length: 90 }, () => ({ p: 0, truth: false })),
    ...Array.from({ length: 10 }, () => ({ p: 0, truth: true }))
  ];
  const map = fitIsotonic(rows);
  assert.ok(Math.abs(calibrate(map, 1) - 0.8) < 0.01);
  assert.ok(Math.abs(calibrate(map, 0) - 0.1) < 0.01);
  assert.ok(calibrate(map, 1) < 0.9, "can no longer close a 0.9 gate alone");
});

test("isotonic output is monotone even when the data is not", () => {
  const rows = [{ p: 0.2, truth: true }, { p: 0.2, truth: true }, { p: 0.5, truth: false }, { p: 0.5, truth: false }, { p: 0.9, truth: true }];
  const map = fitIsotonic(rows, { prior: 0 });
  const vals = [0, 0.2, 0.3, 0.5, 0.7, 0.9, 1].map(p => calibrate(map, p));
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1], `monotone at ${i}`);
});

test("prior keeps tiny blocks from claiming certainty", () => {
  const map = fitIsotonic([{ p: 0.99, truth: true }], { prior: 2 });
  assert.ok(calibrate(map, 0.99) < 0.9);
});

test("calibrateProof keeps raw confidence for audit; no map → identity", () => {
  const map = fitIsotonic(Array.from({ length: 10 }, (_, i) => ({ p: 1, truth: i < 7 })));
  const p = calibrateProof({ source_type: "SMALL_MODEL", provider: "workers-ai", confidence: 1 }, { "workers-ai": map });
  assert.equal(p.evidence.raw_confidence, 1);
  assert.ok(p.confidence < 0.8);
  const same = { source_type: "SENSOR", confidence: 0.9 };
  assert.equal(calibrateProof(same, { "workers-ai": map }), same);
});

test("reliability reports wrong GOs per threshold", () => {
  const r = reliability([{ p: 0.95, truth: false }, { p: 0.95, truth: true }, { p: 0.1, truth: false }]);
  assert.equal(r.gate[0.9].go, 2);
  assert.equal(r.gate[0.9].wrongGo, 1);
});
