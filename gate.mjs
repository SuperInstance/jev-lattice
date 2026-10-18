/**
 * Config-driven gating (the engine behind `jev gate` and the GitHub Action).
 *
 *   jev.gates.json
 *   {
 *     "rules": "later directives override earlier ones; # lines are comments",
 *     "threshold": 0.9,
 *     "gates": [
 *       { "id": "redis-tls", "question": "Is TLS enabled (a tls-port is configured)?", "reads": ["deploy/redis.conf"] },
 *       { "id": "no-debug",  "question": "Is DEBUG disabled?", "reads": ["deploy/app.env"], "spec": { "confidence_threshold": 0.95 } }
 *     ]
 *   }
 *
 * Flow: load previous state → (re)register gates → read files → retire proofs whose files
 * changed → ask the verifier only about open gates → evaluate → save state. Unchanged files
 * cost nothing on the next run. Fails closed: missing files, verifier errors and OPEN gates
 * are all "not GO".
 */
import fs from "node:fs";
import path from "node:path";
import { JEVLattice } from "./jev-core.js";
import { verifyFiles, invalidateChangedFiles } from "./orchestrator.mjs";

export function loadConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = [];
  if (!Array.isArray(cfg.gates) || cfg.gates.length === 0) errors.push("gates: a non-empty array is required");
  const ids = new Set();
  for (const [i, g] of (cfg.gates || []).entries()) {
    if (!g?.id || typeof g.id !== "string") errors.push(`gates[${i}].id: required string`);
    else if (ids.has(g.id)) errors.push(`gates[${i}].id: duplicate "${g.id}"`);
    else ids.add(g.id);
    if (!g?.question || typeof g.question !== "string") errors.push(`gates[${i}].question: required string`);
    if (!Array.isArray(g?.reads) || g.reads.length === 0) errors.push(`gates[${i}].reads: required non-empty array of file paths`);
  }
  if (cfg.threshold !== undefined && !(cfg.threshold >= 0 && cfg.threshold <= 1)) errors.push("threshold: must be in [0, 1]");
  return { cfg, errors };
}

/**
 * @param {object} o
 * @param {object} o.cfg       parsed config
 * @param {string} o.root      directory the `reads` paths are relative to
 * @param {string} [o.statePath]
 * @param {object|null} o.jev  verifier client (cachedJev(createJev()) in production), null = evaluate only
 */
export async function runGate({ cfg, root = ".", statePath = null, jev = null }) {
  const L = new JEVLattice();
  if (statePath && fs.existsSync(statePath)) {
    const r = L.importState(JSON.parse(fs.readFileSync(statePath, "utf8")));
    if (!r.ok) throw new Error(`state file unreadable: ${r.error}`);
  }
  const threshold = cfg.threshold ?? 0.9;
  // one QUESTION node per gate id; a changed question or spec replaces the node
  const nodeFor = {};
  for (const g of cfg.gates) {
    const tag = `gate:${g.id}`;
    const spec = { confidence_threshold: threshold, ...(g.spec || {}), reads: g.reads };
    const existing = L.listNodes().find(n => n.tags.includes(tag));
    const sameSpec = existing && existing.text === g.question &&
      JSON.stringify(existing.question_spec.reads) === JSON.stringify(g.reads) &&
      existing.question_spec.confidence_threshold === spec.confidence_threshold;
    if (existing && !sameSpec) L.prune(existing.id);
    nodeFor[g.id] = sameSpec ? existing : L.ingest({ text: g.question, tags: [tag], question_spec: spec, linkToNearest: false }).node;
  }
  // gates removed from the config are removed from the state
  for (const n of L.listNodes()) {
    const t = n.tags.find(x => x.startsWith("gate:"));
    if (t && !cfg.gates.some(g => `gate:${g.id}` === t)) L.prune(n.id);
  }

  const files = {}, missing = [];
  for (const p of new Set(cfg.gates.flatMap(g => g.reads))) {
    const abs = path.resolve(root, p);
    if (fs.existsSync(abs)) files[p] = fs.readFileSync(abs, "utf8");
    else missing.push(p);
  }
  const drift = await invalidateChangedFiles(L, { files });
  let verifierError = null, verified = 0;
  if (jev) {
    // only gates whose files all exist can be verified; the rest stay OPEN (fail closed)
    const ids = cfg.gates.filter(g => g.reads.every(p => p in files)).map(g => nodeFor[g.id].id);
    try {
      const r = await verifyFiles(L, { jev, files, ids, rules: cfg.rules || null });
      verified = r.verified;
    } catch (e) {
      verifierError = e.message;
    }
  }
  const results = cfg.gates.map(g => {
    const gate = L.evaluateGoNoGo(nodeFor[g.id].id);
    const missingFiles = g.reads.filter(p => missing.includes(p));
    return {
      id: g.id, question: g.question, verdict: gate.verdict, go: gate.go, margin: gate.margin, fragile: gate.fragile,
      reason: missingFiles.length ? `missing file(s): ${missingFiles.join(", ")}` : gate.reason
    };
  });
  if (statePath) {
    fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(L.exportState(), null, 2));
  }
  const pass = results.every(r => r.go) && missing.length === 0 && !verifierError;
  return { pass, results, missing, verifierError, drift: drift.changedFiles, verified };
}

export function formatResult(run, format = "text") {
  if (format === "json") return JSON.stringify(run, null, 2);
  const icon = r => (r.go ? "✅" : r.verdict === "REFUTED" ? "❌" : "⏸️");
  if (format === "markdown") {
    const lines = [
      `### JEV gates: ${run.pass ? "✅ all GO" : "❌ not all GO"}`,
      "",
      "| gate | verdict | margin | note |",
      "|---|---|---|---|",
      ...run.results.map(r => `| ${icon(r)} \`${r.id}\` | ${r.verdict}${r.fragile ? " ⚠️ fragile" : ""} | ${r.margin ?? "–"} | ${String(r.reason || "").replace(/\|/g, "\\|")} |`)
    ];
    if (run.drift?.length) lines.push("", `Re-verified after changes to: ${run.drift.map(f => `\`${f}\``).join(", ")}`);
    if (run.verifierError) lines.push("", `Verifier error (gates fail closed): ${run.verifierError}`);
    return lines.join("\n");
  }
  const out = run.results.map(r => `${r.go ? "GO     " : r.verdict.padEnd(7)} ${r.fragile ? "(fragile) " : ""}${r.id}  ${r.reason || ""}`);
  out.push("", run.pass ? "PASS: all gates GO" : "FAIL: not all gates GO");
  if (run.verifierError) out.push(`verifier error: ${run.verifierError}`);
  return out.join("\n");
}
