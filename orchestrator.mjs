/**
 * Orchestrator — wires proof providers into the lattice.
 *
 * Runtime-agnostic (Node, browser, Cloudflare Workers): it only needs a
 * JEVLattice plus provider objects with the shapes in providers/*.mjs.
 *
 *   MiniMax (LLM_CHAIN_OF_THOUGHT, cost 0.85) → discovery: proofs + decomposition
 *   Jev     (JEV_NOUL,             cost 0.05) → calibrated cheap verification
 *   Lattice (LATTICE_READ,         cost 0.01) → roll-up of already-closed children
 *
 * The gate itself stays deterministic: providers only append proofs.
 */
import { noulToProof } from "./providers/jev.mjs";
import { stateHash } from "./proof-cache.mjs";

export const MINIMAX_COST_WEIGHT = 0.85;
export const ROLLUP_COST_WEIGHT = 0.01;

function need(lattice, nodeId) {
  const n = lattice.getNode(nodeId);
  if (!n) throw new Error(`node not found: ${nodeId}`);
  if (n.node_type !== "QUESTION") throw new Error(`node ${nodeId} is not a QUESTION`);
  return n;
}

/** The question phrased for a yes/no verifier. */
export function questionText(n) {
  return n.question_spec?.intent && n.question_spec.intent !== n.text
    ? `${n.text}\n(intent: ${n.question_spec.intent})`
    : n.text;
}

/**
 * Build a System One `state` from the lattice itself: the question's own
 * evidence plus nearby observations. This is the "lattice as context" tile —
 * the verifier reads what the lattice already knows.
 */
export function latticeState(lattice, nodeId, { topK = 6 } = {}) {
  const n = need(lattice, nodeId);
  const ctx = lattice.query({ text: n.text, tags: n.tags, topK: topK + 1 }).context || [];
  const observations = ctx
    .filter(c => c.id !== nodeId && c.node_type === "OBSERVATION")
    .map(c => c.text);
  const closed = ctx
    .filter(c => c.id !== nodeId && c.node_type === "QUESTION" && c.go)
    .map(c => `VERIFIED: ${c.text}`);
  return { question: n.text, known_facts: [...closed, ...observations] };
}

/**
 * Ask Jev one Noul about a question node and append the proof.
 * `channel` names the evidence source (e.g. "redis.conf") so that
 * invalidateStale can later retire exactly the proofs built on old evidence.
 */
export async function verifyWithJev(lattice, nodeId, { jev, state, instructions, criteria, channel = null } = {}) {
  const n = need(lattice, nodeId);
  const st = state ?? latticeState(lattice, nodeId);
  const instr = instructions || questionText(n);
  const res = await jev.noul(st, instr, criteria);
  const h = res.state_hash ?? (await stateHash(st));
  const added = lattice.addProof(nodeId, noulToProof(res, { note: "jev noul", instructions: instr, state_hash: h, channel }));
  return { ok: true, p: res.p, model: res.model, latency_ms: res.latency_ms, cached: !!res.cached, state_hash: h, proof: added.proof, gate: lattice.evaluateGoNoGo(nodeId) };
}

/**
 * Speculative fan-out: every open question in one Jev request.
 * `state` is shared (e.g. a config file, a log, a diff). Returns per-node gates.
 */
export async function verifyOpenGates(lattice, { jev, state, ids = null, limit = 64, channel = null } = {}) {
  const targets = lattice
    .listNodes()
    .filter(n => n.node_type === "QUESTION" && (!ids || ids.includes(n.id)))
    .filter(n => lattice.evaluateGoNoGo(n.id).open)
    .slice(0, limit);
  if (targets.length === 0) return { ok: true, verified: 0, results: [] };
  const items = targets.map(n => ({ key: n.id, instructions: questionText(n) }));
  const st = state ?? { known_facts: lattice.listNodes().filter(n => n.node_type === "OBSERVATION").map(n => n.text) };
  const answers = await jev.nouls(st, items);
  const h = answers._state_hash ?? (await stateHash(st));
  const results = [];
  for (const n of targets) {
    const p = answers[n.id]?.p;
    if (typeof p !== "number") continue;
    lattice.addProof(n.id, noulToProof({ p, model: answers[n.id].model || answers._model, latency_ms: answers._latency_ms, cached: answers[n.id].cached }, {
      note: `jev fan-out (${targets.length} in one call)`,
      instructions: questionText(n),
      state_hash: h,
      channel
    }));
    const gate = lattice.evaluateGoNoGo(n.id);
    results.push({ id: n.id, text: n.text, p, verdict: gate.verdict, go: gate.go });
  }
  return { ok: true, verified: results.length, latency_ms: answers._latency_ms, usage: answers._usage, cache: answers._cache || null, state_hash: h, results };
}

/**
 * Drift invalidation by content hash: retire every live proof whose recorded
 * evidence (`evidence.state_hash`, optionally limited to one `channel`) differs
 * from the current state. Proofs built on unchanged evidence stay valid —
 * unlike invalidating by source type, which re-opens everything.
 */
export async function invalidateStale(lattice, { state, channel = null, reason = "evidence changed" } = {}) {
  const current = await stateHash(state);
  let invalidated = 0, kept = 0;
  const reopened = [];
  for (const n of lattice.listNodes()) {
    if (n.node_type !== "QUESTION") continue;
    const wasGo = lattice.evaluateGoNoGo(n.id).go;
    let touched = false;
    for (const p of n.active_proofs || []) {
      const ev = p.evidence;
      if (p.invalidated || !ev?.state_hash) continue;
      if (channel && ev.channel !== channel) continue;
      if (ev.state_hash === current) { kept++; continue; }
      lattice.invalidateProof(n.id, p.proof_id, `${reason} (${ev.state_hash.slice(0, 8)} → ${current.slice(0, 8)})`);
      invalidated++;
      touched = true;
    }
    if (touched && wasGo && !lattice.evaluateGoNoGo(n.id).go) reopened.push(n.id);
  }
  return { ok: true, state_hash: current, invalidated, kept, reopened };
}

/**
 * LLM judgement proof. Any client exposing `json(prompt, opts) → {value, raw}`
 * works (MiniMax, Workers AI, …); provenance decides independence.
 */
export async function proveWithLLM(lattice, nodeId, {
  llm, state, source_type = "LLM_CHAIN_OF_THOUGHT", provider = llm?.provider || "llm", cost_weight = MINIMAX_COST_WEIGHT
} = {}) {
  const n = need(lattice, nodeId);
  const st = state ?? latticeState(lattice, nodeId);
  const prompt = `Decide whether the following yes/no question is TRUE given the evidence.
Question: ${questionText(n)}
Evidence (JSON): ${JSON.stringify(st).slice(0, 12000)}

Reply with JSON: {"answer": "yes"|"no"|"unknown", "probability_yes": number 0..1, "rationale": "≤2 sentences"}.
Be calibrated: if the evidence does not settle it, probability_yes should be near 0.5.`;
  const t0 = Date.now();
  const { value, raw } = await llm.json(prompt, { maxTokens: 2048, temperature: 0.1 });
  const p = Math.max(0, Math.min(1, Number(value.probability_yes)));
  const added = lattice.addProof(nodeId, {
    source_type,
    provider,
    model: raw?.model,
    confidence: Number.isFinite(p) ? p : 0.5,
    cost_weight,
    latency_ms: Date.now() - t0,
    note: String(value.rationale || "").slice(0, 500),
    raw_answer: value.answer
  });
  return { ok: true, p: added.proof.confidence, rationale: value.rationale, proof: added.proof, gate: lattice.evaluateGoNoGo(nodeId) };
}

/** MiniMax chain-of-thought proof: expensive discovery path. */
export function proveWithMiniMax(lattice, nodeId, { mm, state } = {}) {
  return proveWithLLM(lattice, nodeId, { llm: mm, state, provider: "minimax" });
}

/**
 * Decompose a question into atomic yes/no sub-questions (MiniMax), each a
 * BINARY child. Children are cheap for Jev to verify and roll back up.
 */
export async function decompose(lattice, nodeId, { mm, maxSub = 5, threshold } = {}) {
  const n = need(lattice, nodeId);
  const prompt = `Break this verification question into ${maxSub} or fewer ATOMIC yes/no sub-questions.
All sub-questions answering "yes" must jointly imply the parent is "yes".
Each must test exactly ONE condition (no "and"/"or" compounds), be checkable against concrete evidence (configs, logs, docs), and be phrased so "yes" = good.
Parent: ${questionText(n)}

Reply with JSON: {"sub_questions": ["...?", "...?"]}`;
  const { value } = await mm.json(prompt, { maxTokens: 2048, temperature: 0.2 });
  const subs = (value.sub_questions || []).map(String).filter(Boolean).slice(0, maxSub);
  const t = threshold ?? n.question_spec?.confidence_threshold ?? 0.85;
  const children = [];
  for (const text of subs) {
    const r = lattice.ingest({
      text,
      tags: [...n.tags.filter(x => x !== "seeking_verification"), "subquestion"],
      question_spec: { evaluation_mode: "BINARY", confidence_threshold: t, intent: `sub-question of ${n.id}` },
      linkToNearest: false
    });
    r.node.hierarchical_links.parent_node = n.id;
    n.hierarchical_links.child_nodes.push(r.node.id);
    lattice._addEdge(n.id, r.node.id, 0.6, ["decomposition"]);
    lattice._addEdge(r.node.id, n.id, 0.4, ["decomposition"]);
    children.push({ id: r.node.id, text });
  }
  return { ok: true, parent: n.id, children };
}

/**
 * Deterministic roll-up: when every child is GO, the parent gains a cheap
 * LATTICE_READ proof (confidence = weakest child). A REFUTED child adds a
 * refuting proof. No model call — this is the compiled steady state.
 */
export function rollup(lattice, parentId) {
  const n = need(lattice, parentId);
  const kids = (n.hierarchical_links?.child_nodes || []).map(id => lattice.getNode(id)).filter(Boolean);
  if (kids.length === 0) return { ok: true, applied: false, reason: "no children" };
  const gates = kids.map(k => ({ k, g: lattice.evaluateGoNoGo(k.id) }));
  // supersede any earlier roll-up proof
  for (const p of n.active_proofs) {
    if (p.independence_key === "children-rollup" && !p.invalidated) {
      p.invalidated = true;
      p.invalidated_reason = "superseded by newer roll-up";
      p.invalidated_at = new Date().toISOString();
    }
  }
  lattice._recomputeNodeMetrics(n, { reset: true });
  lattice._touch();
  let proof = null;
  if (gates.every(x => x.g.go)) {
    proof = { confidence: Math.min(...gates.map(x => x.g.bestConfidence)), note: `all ${kids.length} children GO` };
  } else if (gates.some(x => x.g.verdict === "REFUTED")) {
    const bad = gates.filter(x => x.g.verdict === "REFUTED");
    proof = { confidence: 0, note: `refuted child: ${bad.map(x => x.k.text).join(" | ").slice(0, 400)}` };
  }
  if (!proof) return { ok: true, applied: false, reason: "children still open", gate: lattice.evaluateGoNoGo(parentId) };
  lattice.addProof(parentId, {
    ...proof,
    source_type: "LATTICE_READ",
    independence_key: "children-rollup",
    cost_weight: ROLLUP_COST_WEIGHT
  });
  return { ok: true, applied: true, ...proof, gate: lattice.evaluateGoNoGo(parentId) };
}

/**
 * Progressive compilation loop for one question:
 *   1. cheap first: Jev Noul
 *   2. if undecided and MiniMax is available: CoT proof (discovery)
 *   3. if undecided: decompose → fan-out verify children with Jev → roll up
 * "Decided" = verdict in `stopOn` (default GO / REFUTED / CONFLICT). Pass
 * stopOn: ["GO"] to keep digging after a refutation — decomposition then
 * explains *which* sub-condition fails (diagnostic mode).
 */
export async function compile(lattice, nodeId, {
  jev, mm, state, decomposeIfOpen = true, stopOn = ["GO", "REFUTED", "CONFLICT"]
} = {}) {
  const trace = [];
  const gate = () => lattice.evaluateGoNoGo(nodeId);
  const decided = () => stopOn.includes(gate().verdict);
  const step = (name, r) => trace.push({ step: name, verdict: gate().verdict, ...r });

  if (jev) {
    const r = await verifyWithJev(lattice, nodeId, { jev, state });
    step("jev_noul", { p: r.p, latency_ms: r.latency_ms });
    if (decided()) return { ok: true, trace, gate: gate() };
  }
  if (mm) {
    const r = await proveWithMiniMax(lattice, nodeId, { mm, state });
    step("minimax_cot", { p: r.p, rationale: r.rationale });
    if (decided()) return { ok: true, trace, gate: gate() };
  }
  if (mm && jev && decomposeIfOpen) {
    const d = await decompose(lattice, nodeId, { mm });
    step("decompose", { children: d.children.map(c => c.text) });
    const v = await verifyOpenGates(lattice, { jev, state, ids: d.children.map(c => c.id) });
    step("jev_fan_out", { results: v.results.map(r => ({ text: r.text, p: r.p, verdict: r.verdict })) });
    const ru = rollup(lattice, nodeId);
    step("rollup", { applied: ru.applied, note: ru.note });
  }
  return { ok: true, trace, gate: gate() };
}
