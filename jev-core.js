/**
 * JEV Lattice Core — browser-native spatial memory + question-graph substrate
 * Schema: jev-lattice/v0.3 (reads v0.2)
 *
 * Design goals:
 * - Tiny, deterministic enough to reason about
 * - Full state serializable (download / upload)
 * - Every operation is a callable tool
 * - Optional question_spec + active_proofs for self-compiling reasoning
 * - No external dependencies
 *
 * Backward compatible: nodes without question_spec behave as free-form observations.
 */

const SCHEMA = "jev-lattice/v0.3";
const DEFAULT_DIM = 2;

function uid(prefix = "n") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Finite number or fallback — unlike `Number(x) || d`, keeps a legitimate 0. */
function num(v, fallback) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function deepClone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 10000) / 10000;
  const b = (((h >>> 16) % 10000) / 10000);
  return [a, b];
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function embed(text, dim = 8) {
  const vec = new Array(dim).fill(0);
  const tokens = (text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return vec;
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    for (let d = 0; d < dim; d++) {
      const bit = (h >>> (d % 16)) & 1;
      vec[d] += bit ? 1 : -0.3;
    }
  }
  let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

/** Multi-proof salience: 1 - Π(1 - P_k) */
function multiProofSalience(proofs) {
  if (!proofs || proofs.length === 0) return 0;
  let prod = 1;
  for (const p of proofs) {
    const c = clamp(Number(p.confidence) || 0, 0, 1);
    prod *= (1 - c);
  }
  return clamp(1 - prod, 0, 1);
}

export class JEVLattice {
  constructor() {
    this.nodes = new Map();
    this.version = 0;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.meta = {
      schema: SCHEMA,
      title: "untitled lattice",
      description: ""
    };
  }

  // ---------- node factory ----------
  createNode({
    text = "",
    tags = [],
    coords = null,
    salience = 0.5,
    uncertainty = 0.3,
    node_type = "OBSERVATION",
    question_spec = null,
    active_proofs = null
  } = {}) {
    const id = uid(node_type === "QUESTION" ? "q" : "jev");
    const emb = embed(text);
    let spatial;
    if (coords && coords.length >= 2) {
      spatial = coords.slice(0, DEFAULT_DIM);
    } else {
      const [hx, hy] = hashText(text || id);
      spatial = [
        clamp((hx * 2 - 1) * 0.7 + emb[0] * 0.3, -1.2, 1.2),
        clamp((hy * 2 - 1) * 0.7 + (emb[1] || 0) * 0.3, -1.2, 1.2)
      ];
    }

    const proofs = Array.isArray(active_proofs) ? active_proofs.map(normalizeProof) : [];
    const derivedSalience = proofs.length
      ? Math.max(salience, multiProofSalience(proofs))
      : salience;

    const node = {
      id,
      node_type: node_type === "QUESTION" ? "QUESTION" : "OBSERVATION",
      text: String(text).slice(0, 2000),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      spatial_coordinate: spatial,
      embedding: emb,
      transition_probabilities: [],
      epistemic_uncertainty: clamp(uncertainty, 0, 1),
      salience_score: clamp(derivedSalience, 0, 1),
      access_frequency: 0,
      last_consolidated: null,
      created_at: new Date().toISOString(),
      hierarchical_links: { parent_node: null, child_nodes: [] },
      // Optional question-graph fields (null = legacy / observation)
      // QUESTION without a spec still gets a gate (BINARY default) — never an implicit GO
      question_spec:
        question_spec || node_type === "QUESTION"
          ? normalizeQuestionSpec(question_spec || {})
          : null,
      active_proofs: proofs
    };

    this.nodes.set(id, node);
    this._touch();
    return node;
  }

  getNode(id) {
    return this.nodes.get(id) || null;
  }

  listNodes() {
    return Array.from(this.nodes.values());
  }

  // ---------- experience / question ingest ----------
  ingest({
    text,
    tags = [],
    linkToNearest = true,
    node_type = null,
    question_spec = null,
    active_proofs = null,
    proof = null // convenience: single initial proof
  } = {}) {
    if (!text || !String(text).trim()) {
      return { ok: false, error: "text required" };
    }

    // Auto-promote to QUESTION if question_spec provided
    const type = question_spec || node_type === "QUESTION" ? "QUESTION" : (node_type || "OBSERVATION");
    let proofs = Array.isArray(active_proofs) ? active_proofs : [];
    if (proof) proofs = [...proofs, normalizeProof(proof)];

    const node = this.createNode({
      text,
      tags,
      node_type: type,
      question_spec,
      active_proofs: proofs,
      salience: type === "QUESTION" ? 0.6 : 0.55,
      uncertainty: type === "QUESTION" ? 0.4 : 0.35
    });

    if (linkToNearest && this.nodes.size > 1) {
      const nearest = this._nearest(node.spatial_coordinate, node.id);
      if (nearest) {
        this._addEdge(node.id, nearest.id, 0.45, tags);
        this._addEdge(nearest.id, node.id, 0.25, tags);
      }
    }
    this._recomputeNodeMetrics(node);
    this._touch();
    return { ok: true, node };
  }

  /** Append an independent proof to a question node */
  addProof(nodeId, proof) {
    const n = this.nodes.get(nodeId);
    if (!n) return { ok: false, error: "node not found" };
    if (!proof || typeof proof !== "object") return { ok: false, error: "proof object required" };
    if (!n.active_proofs) n.active_proofs = [];
    const normalized = normalizeProof(proof);
    n.active_proofs.push(normalized);
    this._recomputeNodeMetrics(n);
    this._touch();
    return { ok: true, node: n, proof: normalized, proofCount: n.active_proofs.length };
  }

  /**
   * Invalidate one verification path (e.g. the config it parsed changed).
   * The proof stays for audit but no longer counts toward any gate.
   */
  invalidateProof(nodeId, proofId, reason = null) {
    const n = this.nodes.get(nodeId);
    if (!n) return { ok: false, error: "node not found" };
    const p = (n.active_proofs || []).find(x => x.proof_id === proofId);
    if (!p) return { ok: false, error: "proof not found" };
    p.invalidated = true;
    p.invalidated_reason = reason;
    p.invalidated_at = new Date().toISOString();
    this._recomputeNodeMetrics(n, { reset: true });
    this._touch();
    return { ok: true, node: n, gate: this.evaluateGoNoGo(nodeId) };
  }

  /**
   * Deterministic go/no-go gate.
   * BINARY: best proof confidence ≥ threshold (or any proof ≥ threshold)
   * COORDINATED: count of independent proofs ≥ threshold ≥ required_k
   */
  evaluateGoNoGo(nodeId, { now = Date.now() } = {}) {
    const n = this.nodes.get(nodeId);
    if (!n) return { ok: false, error: "node not found", go: false };

    // Observations are not gates
    if (n.node_type !== "QUESTION") {
      return {
        ok: true,
        go: true,
        gated: false,
        reason: "not a gated question node",
        node_type: n.node_type || "OBSERVATION"
      };
    }

    const spec = n.question_spec || normalizeQuestionSpec({});
    const mode = spec.evaluation_mode;
    const threshold = spec.confidence_threshold;
    const required = mode === "BINARY" ? 1 : spec.required_independent_proofs;
    const live = liveProofs(n.active_proofs, spec, now);

    // One verification path = one independence key. Its CURRENT reading is the most
    // recently appended live proof — not the best one. Keeping the max would let a
    // caller re-ask a non-deterministic verifier until it passes (cherry-picking).
    const paths = currentPaths(live);
    // Per-source bar: e.g. { SMALL_MODEL: 0.99 } for a source whose 0.9 isn't worth 0.9
    const bar = p => spec.source_thresholds?.[p.source_type] ?? threshold;
    const valid = paths.filter(p => p.confidence >= bar(p));
    // Refutation: a path's current reading confidently says "no" (confidence ≤ 1 − threshold)
    const refuting = new Set(paths.filter(p => p.confidence <= 1 - bar(p)).map(independenceKey));
    const satisfied = valid.length >= required;
    const conflict = satisfied && refuting.size > 0;
    const go = satisfied && !(conflict && spec.block_on_conflict);
    const verdict = conflict ? "CONFLICT" : satisfied ? "GO" : refuting.size ? "REFUTED" : "OPEN";
    const base = {
      ok: true,
      go,
      gated: true,
      open: !go,
      verdict,
      refutingProofs: refuting.size,
      mode,
      validProofs: valid.length,
      required,
      threshold,
      liveProofs: live.length,
      ignoredProofs: (n.active_proofs || []).length - live.length,
      paths: paths.length,
      bestConfidence: paths.reduce((m, p) => Math.max(m, p.confidence), 0),
      proofSources: valid.map(p => p.source_type),
      multiProofSalience: multiProofSalience(paths)
    };
    if (conflict) {
      return {
        ...base,
        reason: `${valid.length} supporting vs ${refuting.size} refuting path(s)` +
          (go ? " — conflict allowed by spec" : " — conflict blocks GO")
      };
    }
    if (mode === "BINARY") {
      return {
        ...base,
        reason: go ? "binary proof satisfied" : refuting.size ? "refuted by proof" : "no proof meets threshold"
      };
    }
    return {
      ...base,
      reason: go
        ? `${valid.length}/${required} independent proofs satisfied`
        : refuting.size
          ? `refuted by ${refuting.size} path(s); ${valid.length}/${required} supporting`
          : `need ${required - valid.length} more independent proof(s) ≥ ${threshold}`
    };
  }

  // ---------- spatial + probabilistic query ----------
  query({ text, tags = [], topK = 4, beam = 3 } = {}) {
    tags = Array.isArray(tags) ? tags.map(String) : [];
    topK = Math.max(1, Math.floor(num(topK, 4)));
    beam = Math.max(1, Math.floor(num(beam, 3)));
    if (this.nodes.size === 0) {
      return { ok: true, path: [], context: [], latencyHint: 0 };
    }
    const t0 = performance.now();
    const qEmb = embed(text || "");
    const qSpatial = [qEmb[0] || 0, qEmb[1] || 0];

    let best = null;
    let bestScore = -Infinity;
    for (const n of this.nodes.values()) {
      const spatialScore = 1 / (1 + dist(qSpatial, n.spatial_coordinate));
      const embScore = cosine(qEmb, n.embedding);
      const tagBoost = tags.some(t => n.tags.includes(t)) ? 0.15 : 0;
      // Prefer closed / low-uncertainty / multi-proof nodes
      const closedBoost = n.node_type === "QUESTION" && !this.evaluateGoNoGo(n.id).open ? 0.12 : 0;
      const score =
        0.4 * spatialScore +
        0.35 * embScore +
        0.15 * n.salience_score +
        tagBoost +
        closedBoost;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (!best) return { ok: true, path: [], context: [], latencyHint: 0 };

    const path = [best];
    const visited = new Set([best.id]);
    let current = best;
    for (let step = 0; step < beam - 1; step++) {
      const edges = (current.transition_probabilities || [])
        .filter(e => !visited.has(e.target_node_id))
        .map(e => {
          const target = this.nodes.get(e.target_node_id);
          if (!target) return null;
          const tagMatch = (e.conditional_trigger_tags || []).some(
            t => tags.includes(t) || (text || "").includes(t)
          );
          const costBias = this._cheapestProofCost(target);
          const score =
            e.probability *
            (0.65 + 0.25 * target.salience_score) *
            (tagMatch ? 1.35 : 1) *
            (1.1 - 0.4 * costBias); // prefer cheaper proof paths
          return { edge: e, target, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      if (edges.length === 0) break;
      const next = edges[0];
      path.push(next.target);
      visited.add(next.target.id);
      current = next.target;
      current.access_frequency = (current.access_frequency || 0) + 1;
    }

    const extras = this._kNearest(qSpatial, topK + 2)
      .filter(n => !visited.has(n.id))
      .slice(0, Math.max(0, topK - path.length));

    const context = [...path, ...extras].slice(0, topK);
    const latency = performance.now() - t0;
    this._touch();
    return {
      ok: true,
      path: path.map(n => this._nodeSummary(n)),
      context: context.map(n => this._nodeSummary(n)),
      latencyMs: Math.round(latency * 100) / 100
    };
  }

  // ---------- consolidation (idle cycle + independent proof awareness) ----------
  consolidate({
    pruneFloor = 0.08,
    mergeDistance = 0.18,
    stitchRadius = 0.45
  } = {}) {
    const before = this.nodes.size;
    let pruned = 0;
    let edgesAdded = 0;
    let merged = 0;
    let seeking = 0;

    const list = this.listNodes();

    // 1. Edge stitching
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const d = dist(a.spatial_coordinate, b.spatial_coordinate);
        if (d < stitchRadius) {
          const shared = a.tags.filter(t => b.tags.includes(t));
          const base = clamp(0.55 - d, 0.05, 0.7);
          const boost = shared.length ? 0.12 : 0;
          if (this._addEdge(a.id, b.id, base + boost, shared)) edgesAdded++;
          if (this._addEdge(b.id, a.id, (base + boost) * 0.7, shared)) edgesAdded++;
        }
      }
    }

    // 2. Soft merge of extremely close OBSERVATION nodes (do not merge gated questions)
    const removed = new Set();
    for (let i = 0; i < list.length; i++) {
      if (removed.has(list[i].id)) continue;
      if (list[i].node_type === "QUESTION") continue;
      for (let j = i + 1; j < list.length; j++) {
        if (removed.has(list[j].id)) continue;
        if (list[j].node_type === "QUESTION") continue;
        const a = list[i], b = list[j];
        if (dist(a.spatial_coordinate, b.spatial_coordinate) < mergeDistance) {
          const keep = a.salience_score >= b.salience_score ? a : b;
          const drop = keep === a ? b : a;
          keep.text = (keep.text + " · " + drop.text).slice(0, 2000);
          keep.tags = Array.from(new Set([...keep.tags, ...drop.tags]));
          keep.salience_score = clamp(keep.salience_score + 0.05, 0, 1);
          keep.epistemic_uncertainty = Math.min(keep.epistemic_uncertainty, drop.epistemic_uncertainty);
          keep.access_frequency = (keep.access_frequency || 0) + (drop.access_frequency || 0);
          keep.transition_probabilities = [
            ...(keep.transition_probabilities || []),
            ...(drop.transition_probabilities || [])
          ];
          for (const n of this.nodes.values()) {
            n.transition_probabilities = (n.transition_probabilities || [])
              .map(e => (e.target_node_id === drop.id ? { ...e, target_node_id: keep.id } : e))
              .filter(e => e.target_node_id !== n.id)
              .filter((e, idx, arr) => arr.findIndex(x => x.target_node_id === e.target_node_id) === idx);
          }
          this.nodes.delete(drop.id);
          removed.add(drop.id);
          merged++;
        }
      }
    }

    // 3. Prune low-salience, low-access observations
    for (const n of [...this.nodes.values()]) {
      if (n.node_type === "QUESTION") continue; // never auto-prune gated questions
      if (n.salience_score < pruneFloor && (n.access_frequency || 0) < 2) {
        this._deleteNode(n.id);
        pruned++;
      }
    }

    // 4. Metrics + mark open coordinated questions as seeking verification
    for (const n of this.nodes.values()) {
      if ((n.access_frequency || 0) > 0) {
        n.epistemic_uncertainty = clamp(n.epistemic_uncertainty * 0.92, 0.02, 1);
        n.salience_score = clamp(n.salience_score + 0.01, 0, 1);
      } else {
        n.salience_score = clamp(n.salience_score * 0.985, 0, 1);
      }
      this._recomputeNodeMetrics(n);
      n.last_consolidated = new Date().toISOString();

      if (n.node_type === "QUESTION" && n.question_spec) {
        const gate = this.evaluateGoNoGo(n.id);
        if (gate.open) {
          seeking++;
          // Tag for UI / external schedulers
          if (!n.tags.includes("seeking_verification")) {
            n.tags = [...n.tags, "seeking_verification"];
          }
        } else {
          n.tags = (n.tags || []).filter(t => t !== "seeking_verification");
        }
      }
    }

    this._touch();
    return {
      ok: true,
      before,
      after: this.nodes.size,
      edgesAdded,
      pruned,
      merged,
      seekingVerification: seeking
    };
  }

  boost(id, delta = 0.1) {
    const n = this.nodes.get(id);
    if (!n) return { ok: false, error: "node not found" };
    n.salience_score = clamp(n.salience_score + delta, 0, 1);
    n.access_frequency = (n.access_frequency || 0) + 1;
    this._touch();
    return { ok: true, node: n };
  }

  prune(id) {
    if (!this.nodes.has(id)) return { ok: false, error: "node not found" };
    this._deleteNode(id);
    this._touch();
    return { ok: true, removed: id };
  }

  // ---------- state I/O ----------
  exportState() {
    return {
      schema: SCHEMA,
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      meta: { ...this.meta },
      nodes: this.listNodes().map(n => deepClone(n))
    };
  }

  importState(state) {
    if (!state || typeof state !== "object") {
      return { ok: false, error: "invalid state object" };
    }
    if (state.schema && !String(state.schema).startsWith("jev-lattice/")) {
      console.warn("Unexpected schema:", state.schema);
    }
    if (state.nodes !== undefined && !Array.isArray(state.nodes)) {
      return { ok: false, error: "state.nodes must be an array" };
    }
    this.nodes.clear();
    const nodes = deepClone(state.nodes || []);
    for (const raw of nodes) {
      if (!raw.id) continue;
      const proofs = Array.isArray(raw.active_proofs)
        ? raw.active_proofs.map(normalizeProof)
        : [];
      this.nodes.set(raw.id, {
        id: raw.id,
        node_type: raw.node_type === "QUESTION" ? "QUESTION" : "OBSERVATION",
        text: raw.text || "",
        tags: raw.tags || [],
        spatial_coordinate: sanitizeCoord(raw.spatial_coordinate),
        embedding: raw.embedding || embed(raw.text || ""),
        transition_probabilities: raw.transition_probabilities || [],
        epistemic_uncertainty: raw.epistemic_uncertainty ?? 0.3,
        salience_score: raw.salience_score ?? 0.5,
        access_frequency: raw.access_frequency || 0,
        last_consolidated: raw.last_consolidated || null,
        created_at: raw.created_at || new Date().toISOString(),
        hierarchical_links: raw.hierarchical_links || { parent_node: null, child_nodes: [] },
        question_spec:
          raw.question_spec || raw.node_type === "QUESTION"
            ? normalizeQuestionSpec(raw.question_spec || {})
            : null,
        active_proofs: proofs
      });
    }
    this.version = num(state.version, 0);
    this.createdAt = state.createdAt || new Date().toISOString();
    this.updatedAt = state.updatedAt || new Date().toISOString();
    this.meta = { ...(state.meta || {}), schema: SCHEMA };
    this._touch();
    return { ok: true, nodes: this.nodes.size };
  }

  stats() {
    let edges = 0;
    let questions = 0;
    let openGates = 0;
    let sumSal = 0;
    let sumUnc = 0;
    for (const n of this.nodes.values()) {
      edges += (n.transition_probabilities || []).length;
      sumSal += n.salience_score;
      sumUnc += n.epistemic_uncertainty;
      if (n.node_type === "QUESTION") {
        questions++;
        const g = this.evaluateGoNoGo(n.id);
        if (g.open) openGates++;
      }
    }
    const count = this.nodes.size || 1;
    return {
      ok: true,
      nodes: this.nodes.size,
      questions,
      openGates,
      edges,
      avgSalience: Math.round((sumSal / count) * 1000) / 1000,
      avgUncertainty: Math.round((sumUnc / count) * 1000) / 1000,
      version: this.version,
      schema: SCHEMA
    };
  }

  // ---------- internals ----------
  _touch() {
    this.version += 1;
    this.updatedAt = new Date().toISOString();
  }

  _recomputeNodeMetrics(n, { reset = false } = {}) {
    const live = (n.active_proofs || []).filter(p => !p.invalidated);
    if (live.length) {
      const mps = multiProofSalience(live);
      n.salience_score = clamp(reset ? mps : Math.max(n.salience_score, mps), 0, 1);
      // Uncertainty falls as independent proofs accumulate
      const avgConf = live.reduce((s, p) => s + p.confidence, 0) / live.length;
      n.epistemic_uncertainty = clamp(1 - avgConf, 0.02, 1);
    } else if (reset) {
      n.epistemic_uncertainty = Math.max(n.epistemic_uncertainty, 0.4);
    }
  }

  _cheapestProofCost(n) {
    const live = (n.active_proofs || []).filter(p => !p.invalidated);
    if (live.length === 0) return 0.9;
    return Math.min(...live.map(p => p.cost_weight));
  }

  _nodeSummary(n) {
    const gate = n.node_type === "QUESTION" ? this.evaluateGoNoGo(n.id) : null;
    return {
      id: n.id,
      text: n.text,
      tags: n.tags,
      node_type: n.node_type,
      salience: n.salience_score,
      uncertainty: n.epistemic_uncertainty,
      proofs: (n.active_proofs || []).length,
      go: gate ? gate.go : undefined,
      open: gate ? gate.open : undefined
    };
  }

  _addEdge(fromId, toId, probability, tags = []) {
    const from = this.nodes.get(fromId);
    if (!from || fromId === toId) return false;
    from.transition_probabilities = from.transition_probabilities || [];
    const existing = from.transition_probabilities.find(e => e.target_node_id === toId);
    if (existing) {
      existing.probability = clamp((existing.probability + probability) / 2, 0.01, 0.99);
      existing.conditional_trigger_tags = Array.from(
        new Set([...(existing.conditional_trigger_tags || []), ...tags])
      );
      return false;
    }
    from.transition_probabilities.push({
      target_node_id: toId,
      probability: clamp(probability, 0.01, 0.99),
      conditional_trigger_tags: [...tags],
      confidence_bounds: [
        clamp(probability - 0.08, 0, 1),
        clamp(probability + 0.08, 0, 1)
      ]
    });
    return true;
  }

  _deleteNode(id) {
    this.nodes.delete(id);
    for (const n of this.nodes.values()) {
      n.transition_probabilities = (n.transition_probabilities || []).filter(
        e => e.target_node_id !== id
      );
    }
  }

  _nearest(coord, excludeId = null) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (n.id === excludeId) continue;
      const d = dist(coord, n.spatial_coordinate);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  _kNearest(coord, k = 5) {
    return this.listNodes()
      .map(n => ({ n, d: dist(coord, n.spatial_coordinate) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)
      .map(x => x.n);
  }
}

function sanitizeCoord(c) {
  const out = [0, 0];
  if (Array.isArray(c)) for (let i = 0; i < DEFAULT_DIM; i++) out[i] = num(c[i], 0);
  return out;
}

function normalizeQuestionSpec(spec) {
  if (!spec || typeof spec !== "object") spec = {};
  const mode = String(spec.evaluation_mode || "BINARY").toUpperCase();
  const maxAge = num(spec.max_proof_age_ms, null);
  return {
    evaluation_mode: mode === "COORDINATED" ? "COORDINATED" : "BINARY",
    required_independent_proofs: Math.max(1, Math.floor(num(spec.required_independent_proofs, 1))),
    confidence_threshold: clamp(num(spec.confidence_threshold, 0.85), 0, 1),
    intent: spec.intent || null,
    // Optional: proofs older than this stop counting (deterministic given `now`)
    max_proof_age_ms: maxAge !== null && maxAge > 0 ? maxAge : null,
    // Optional: only these source types may close the gate
    allowed_sources: Array.isArray(spec.allowed_sources) && spec.allowed_sources.length
      ? spec.allowed_sources.map(String)
      : null,
    // A confident "no" alongside enough "yes" paths blocks GO unless disabled
    block_on_conflict: spec.block_on_conflict !== false,
    // Optional: per-source_type thresholds overriding confidence_threshold
    source_thresholds: normalizeSourceThresholds(spec.source_thresholds)
  };
}

function normalizeSourceThresholds(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    const n = num(v, null);
    if (n !== null) out[String(k)] = clamp(n, 0, 1);
  }
  return Object.keys(out).length ? out : null;
}

function normalizeProof(p) {
  if (!p || typeof p !== "object") p = {};
  const out = {
    proof_id: p.proof_id || uid("proof"),
    source_type: String(p.source_type || "UNKNOWN"),
    confidence: clamp(num(p.confidence, 0.5), 0, 1),
    cost_weight: clamp(num(p.cost_weight, 0.5), 0, 1),
    timestamp: p.timestamp || new Date().toISOString(),
    note: p.note || null
  };
  // Optional provenance — carried through untouched when present
  for (const k of ["provider", "model", "independence_key", "evidence", "latency_ms", "raw_answer"]) {
    if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  }
  if (p.invalidated) {
    out.invalidated = true;
    out.invalidated_reason = p.invalidated_reason || null;
    out.invalidated_at = p.invalidated_at || null;
  }
  return out;
}

/** Proofs from the same independence key are one verification path. */
function independenceKey(p) {
  if (p.independence_key) return String(p.independence_key);
  return p.provider ? `${p.source_type}:${p.provider}` : p.source_type;
}

/** Latest live proof per independence key, in append order (the proof log is the clock). */
function currentPaths(live) {
  const byKey = new Map();
  for (const p of live) byKey.set(independenceKey(p), p);
  return [...byKey.values()];
}

function liveProofs(proofs, spec, now = Date.now()) {
  return (proofs || []).filter(p => {
    if (p.invalidated) return false;
    if (spec.allowed_sources && !spec.allowed_sources.includes(p.source_type)) return false;
    if (spec.max_proof_age_ms) {
      const t = Date.parse(p.timestamp);
      if (!Number.isFinite(t) || now - t > spec.max_proof_age_ms) return false;
    }
    return true;
  });
}

/**
 * Public tool surface — every capability is callable.
 */
export function createToolRegistry(lattice) {
  return {
    ingest: (args = {}) => lattice.ingest(args),
    addProof: (args = {}) => lattice.addProof(args.id || args.nodeId, args.proof || args),
    evaluateGoNoGo: (args = {}) => lattice.evaluateGoNoGo(args.id || args.nodeId, args.now ? { now: args.now } : {}),
    invalidateProof: (args = {}) => lattice.invalidateProof(args.id || args.nodeId, args.proof_id, args.reason),
    query: (args = {}) => lattice.query(args),
    consolidate: (args = {}) => lattice.consolidate(args),
    exportState: () => lattice.exportState(),
    importState: (args = {}) => lattice.importState(args.state || args),
    listNodes: () => ({ ok: true, nodes: lattice.listNodes() }),
    getNode: (args = {}) => {
      const n = lattice.getNode(args.id);
      return n ? { ok: true, node: n } : { ok: false, error: "not found" };
    },
    prune: (args = {}) => lattice.prune(args.id),
    boost: (args = {}) => lattice.boost(args.id, args.delta),
    stats: () => lattice.stats(),
    listTools: () => ({
      ok: true,
      tools: [
        "ingest", "addProof", "invalidateProof", "evaluateGoNoGo", "query", "consolidate",
        "exportState", "importState", "listNodes", "getNode", "prune",
        "boost", "stats", "listTools"
      ]
    })
  };
}

export {
  SCHEMA, embed, dist, cosine, multiProofSalience,
  normalizeProof, normalizeQuestionSpec, independenceKey
};
