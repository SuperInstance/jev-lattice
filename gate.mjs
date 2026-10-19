/**
 * Config-driven gating (the engine behind `jev gate` and the GitHub Action).
 *
 *   jev.gates.json
 *   {
 *     "rules": "later directives override earlier ones; # lines are comments",
 *     "threshold": 0.9,
 *     "gates": [
 *       { "id": "redis-tls", "question": "Is TLS enabled (a tls-port is configured)?", "reads": ["deploy/redis.conf"] },
 *       { "id": "no-debug",  "question": "Is DEBUG disabled?", "reads": ["deploy/app.env"], "spec": { "confidence_threshold": 0.95 } },
 *       { "id": "mem", "question": "Is maxmemory at least 1 GiB?", "reads": ["deploy/redis.conf"],
 *         "focus": "the maxmemory directive", "criteria": { "true": "...", "false": { "what": "...", "not_for": "..." } } }
 *     ],
 *     "facts": { "deploy/redis.conf": [{ "name": "maxmemory_bytes", "extract": "size", "key": "maxmemory" }] },
 *     "quarantine": false,         // true for untrusted input (e.g. PRs from forks)
 *     "strip_comments": true       // default: drop full-line comments before Jev reads (facts still see them)
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
import { verifyFiles, invalidateChangedFiles, frameEvidence, jevQuestion } from "./orchestrator.mjs";
import { checkFactSpecs, factsForFiles } from "./facts.mjs";

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
    if (g?.focus !== undefined && typeof g.focus !== "string") errors.push(`gates[${i}].focus: must be a string`);
    if (g?.criteria !== undefined && (typeof g.criteria !== "object" || g.criteria === null || Array.isArray(g.criteria) || !("true" in g.criteria || "false" in g.criteria))) errors.push(`gates[${i}].criteria: an object with "true" and/or "false"`);
  }
  if (cfg.facts !== undefined) {
    if (typeof cfg.facts !== "object" || cfg.facts === null || Array.isArray(cfg.facts)) errors.push("facts: an object mapping file paths to fact specs");
    else for (const [file, specs] of Object.entries(cfg.facts)) errors.push(...checkFactSpecs(specs, `facts["${file}"]`, file));
  }
  if (cfg.quarantine !== undefined && typeof cfg.quarantine !== "boolean") errors.push("quarantine: must be true or false");
  if (cfg.strip_comments !== undefined && typeof cfg.strip_comments !== "boolean") errors.push("strip_comments: must be true or false");
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
    const spec = { confidence_threshold: threshold, ...(g.spec || {}), reads: g.reads, ...(g.focus ? { focus: g.focus } : {}), ...(g.criteria ? { criteria: g.criteria } : {}) };
    const existing = L.listNodes().find(n => n.tags.includes(tag));
    // anything that changes what is asked replaces the node (and its proofs)
    const asked = q => JSON.stringify([q.reads, q.confidence_threshold, q.focus ?? null, q.criteria ?? null]);
    const sameSpec = existing && existing.text === g.question &&
      asked(existing.question_spec) === asked({ ...spec, focus: spec.focus ?? null, criteria: spec.criteria ?? null });
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
      const r = await verifyFiles(L, { jev, files, ids, rules: cfg.rules || null, quarantine: cfg.quarantine === true, stripComments: cfg.strip_comments !== false, facts: cfg.facts ? factsForFiles(files, cfg.facts) : null });
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

/**
 * Gate lint (R6): ask every gate about EMPTY versions of its files, in one call. A gate that is
 * decided with no evidence answers from priors: GO-on-empty means "absent = pass" (often a
 * phrasing problem, e.g. "Is DEBUG disabled?" leaned yes on an empty env file); a lean
 * (p ≥ 0.6) is reported as a warning. Also flags gates that read many files (irrelevant files
 * doubled Brier) and negated phrasing (negations produced the only wrong GOs in R6).
 */
export async function lintGates({ cfg, jev }) {
  const threshold = cfg.threshold ?? 0.9;
  const findings = [];
  const negated = /\b(not|no|never|without|disabled|absent|missing|isn't|doesn't)\b/i;
  for (const g of cfg.gates) {
    if (g.reads.length > 3) findings.push({ gate: g.id, level: "warn", issue: `reads ${g.reads.length} files; each extra file dilutes the evidence (R6: 3 unrelated files doubled Brier)` });
    if (negated.test(g.question)) findings.push({ gate: g.id, level: "info", issue: "negated phrasing; positive phrasing was more reliable in R6 (high p should mean the safe state is present)" });
  }
  if (jev) {
    const items = cfg.gates.map(g => ({ key: g.id, ...jevQuestion({ text: g.question, question_spec: { focus: g.focus ?? null, criteria: g.criteria ?? null } }) }));
    const groups = new Map();
    for (const g of cfg.gates) { const k = [...g.reads].sort().join("\n"); (groups.get(k) || groups.set(k, []).get(k)).push(g.id); }
    for (const [k, ids] of groups) {
      const empty = Object.fromEntries(k.split("\n").map(p => [p, ""]));
      const ans = await jev.nouls(frameEvidence(empty, { rules: cfg.rules || null }), items.filter(it => ids.includes(it.key)));
      for (const id of ids) {
        const p = ans[id]?.p;
        if (typeof p !== "number") continue;
        if (p >= threshold) findings.push({ gate: id, level: "error", p, issue: "GO with empty files: the gate passes when its evidence is absent. Rephrase so absence is not a pass, or add a fact with an explicit default." });
        else if (p >= 0.6) findings.push({ gate: id, level: "warn", p, issue: "leans yes with empty files; the verdict may rest on priors rather than evidence" });
      }
    }
  }
  return { ok: !findings.some(f => f.level === "error"), findings };
}

/**
 * Model-upgrade rehearsal: evaluate every gate from scratch (no saved state) with the current
 * verifier and with a candidate, on the same files, and report the verdicts that would move.
 * Nothing is persisted. R5-E: 1.13.0 → 1.14.0 moved 4.7–6.2% of verdicts, so rehearse before
 * changing a pin.
 */
export async function compareModels({ cfg, root = ".", jev, candidate }) {
  const [a, b] = await Promise.all([runGate({ cfg, root, jev }), runGate({ cfg, root, jev: candidate })]);
  const byId = new Map(b.results.map(r => [r.id, r]));
  const rows = a.results.map(r => {
    const c = byId.get(r.id);
    return { id: r.id, current: r.verdict, candidate: c.verdict, moved: r.verdict !== c.verdict, margin: [r.margin, c.margin], fragile: [r.fragile, c.fragile] };
  });
  return {
    current_model: jev.model, candidate_model: candidate.model,
    moved: rows.filter(r => r.moved).length, total: rows.length,
    pass: { current: a.pass, candidate: b.pass },
    errors: [a.verifierError, b.verifierError].filter(Boolean),
    rows
  };
}

export function formatComparison(c, format = "text") {
  if (format === "json") return JSON.stringify(c, null, 2);
  const head = `Model rehearsal: ${c.current_model} → ${c.candidate_model}: ${c.moved}/${c.total} verdict(s) would move; run passes: ${c.pass.current} → ${c.pass.candidate}`;
  const rows = c.rows.map(r => `${r.moved ? "MOVES " : "same  "} ${r.id.padEnd(24)} ${r.current.padEnd(8)} → ${r.candidate.padEnd(8)} margin ${r.margin[0] ?? "–"} → ${r.margin[1] ?? "–"}`);
  return [head, ...rows, ...c.errors.map(e => `verifier error: ${e}`)].join("\n");
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
