#!/usr/bin/env node
/**
 * Per-source calibration (backlog 3): fit isotonic maps on one split, evaluate on another.
 *   node experiments/calibration.mjs --seed 7  --worker … --rows experiments/results/calib-rows-fit.json
 *   node experiments/calibration.mjs --seed 99 --worker … --rows experiments/results/calib-rows-eval.json
 *   node experiments/calibrate-sources.mjs [fit.json] [eval.json] [--maps out.json]
 */
import fs from "node:fs";
import { fitIsotonic, calibrate, reliability } from "../calibration.mjs";

const [fitPath = "experiments/results/calib-rows-fit.json", evalPath = "experiments/results/calib-rows-eval.json"] = process.argv.slice(2).filter(a => !a.startsWith("--") && !a.endsWith("maps.json"));
const mapsOut = process.argv.includes("--maps") ? process.argv[process.argv.indexOf("--maps") + 1] : null;
const fit = JSON.parse(fs.readFileSync(fitPath, "utf8"));
const evalRows = JSON.parse(fs.readFileSync(evalPath, "utf8"));
const sources = [...new Set(fit.map(r => r.source))];

const maps = {};
console.log("source       split  |  brier    ECE   | GO@0.8 wrong recall | GO@0.9 wrong recall | GO@0.95 wrong recall");
const line = (src, tag, m) => console.log(
  `${src.padEnd(11)}  ${tag.padEnd(5)}  | ${m.brier.toFixed(4)}  ${m.ece.toFixed(4)} |` +
  [0.8, 0.9, 0.95].map(t => ` ${String(m.gate[t].go).padStart(6)} ${String(m.gate[t].wrongGo).padStart(5)} ${m.gate[t].recall.toFixed(3).padStart(6)} |`).join("")
);
const out = {};
for (const src of sources) {
  const f = fit.filter(r => r.source === src);
  const e = evalRows.filter(r => r.source === src);
  maps[src] = fitIsotonic(f, { prior: 2 });
  const raw = reliability(e);
  const cal = reliability(e.map(r => ({ ...r, p: calibrate(maps[src], r.p) })));
  line(src, "raw", raw);
  line(src, "calib", cal);
  out[src] = { raw, calibrated: cal, map: maps[src] };
}

// What does a calibrated 1.0 mean per source?  (the most a single proof can be worth)
console.log("\nvalue of a raw p=1.0 after calibration:", Object.fromEntries(sources.map(s => [s, calibrate(maps[s], 1)])));

// Gate effect: COORDINATED k=2 pairs before/after calibration on eval
const byCase = {};
for (const r of evalRows) (byCase[r.case] ||= {})[r.source] = r;
for (const [a, b] of [["jev", "workers-ai"], ["minimax", "workers-ai"], ["jev", "minimax"]]) {
  for (const tag of ["raw", "calib"]) {
    const t = 0.9;
    const P = (r, s) => (tag === "raw" ? r.p : calibrate(maps[s], r.p));
    const cs = Object.values(byCase).filter(c => c[a] && c[b]);
    const go = cs.filter(c => P(c[a], a) >= t && P(c[b], b) >= t);
    const wrong = go.filter(c => !c[a].truth).length;
    console.log(`COORDINATED(${a}+${b}) ${tag.padEnd(5)} @0.9: GO ${go.length}, wrong ${wrong}, recall ${(go.filter(c => c[a].truth).length / cs.filter(c => c[a].truth).length).toFixed(3)}`);
  }
}
if (mapsOut) fs.writeFileSync(mapsOut, JSON.stringify({ fittedOn: fitPath, at: new Date().toISOString(), maps }, null, 2));
fs.writeFileSync("experiments/results/calibrate-sources.json", JSON.stringify(out, null, 2));
