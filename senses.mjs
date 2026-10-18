/**
 * Cross-sense teaching (T29) — "if you know something by sight, let that truth
 * calibrate the smell and sound".
 *
 * When a gate is DECIDED by the strongest channel (the teacher: e.g. Jev reading
 * only the relevant file), the verdict is a free label. Spend spare question
 * budget probing weaker channels ("senses") on the same evidence and bank
 * (p, label) pairs. Over time the bank says, per question × sense, how far
 * that sense can be trusted — learned without ground truth — so a weaker or
 * cheaper sense can stand in later with an earned threshold, or be blocked.
 *
 * Runtime-agnostic: senses are injected functions, the bank uses any
 * memoryStore/durableObjectStore-shaped store (proof-cache.mjs).
 */
import { sha256Hex } from "./proof-cache.mjs";

const MAX_SAMPLES = 400;

export async function questionKey(text) {
  return (await sha256Hex(text)).slice(0, 20);
}

export function createLabelBank(store) {
  async function add(question, sense, samples) {
    const k = `label:${await questionKey(question)}:${sense}`;
    const prev = (await store.get(k)) || { question, sense, samples: [] };
    prev.samples = [...prev.samples, ...samples].slice(-MAX_SAMPLES);
    await store.set(k, prev);
    return prev.samples.length;
  }
  async function get(question, sense) {
    return store.get(`label:${await questionKey(question)}:${sense}`);
  }
  return { add, get, store };
}

/**
 * Smallest threshold t (integer grid, P4) at which the sense never said GO
 * against a teacher NO, with at least `minGo` GOs supporting it. null = no safe t.
 */
/**
 * How many teacher "no"s among m GO-side samples are explainable by teacher noise alone:
 * the smallest k with P(Binomial(m, ε) > k) ≤ alpha. ε = 0 → 0 (fail-safe).
 */
export function allowedDisagreements(m, eps, alpha = 0.05) {
  if (!(eps > 0) || m <= 0) return 0;
  let pk = (1 - eps) ** m, cdf = pk;
  for (let k = 0; k < m; k++) {
    if (1 - cdf <= alpha) return k;
    pk *= ((m - k) / (k + 1)) * (eps / (1 - eps));
    cdf += pk;
  }
  return m;
}

/**
 * Teacher error rate from an audit: pairs of [teacherLabel, goldLabel] (e.g. calibration rows
 * with code truth, or a hand-checked sample). → { rate, n, errors, upper95 }
 */
export function teacherErrorRate(pairs) {
  const used = pairs.filter(([t, g]) => t !== null && t !== undefined && g !== null && g !== undefined);
  const n = used.length, errors = used.filter(([t, g]) => !!t !== !!g).length;
  if (!n) return { rate: null, n: 0, errors: 0, upper95: null };
  // Wilson upper bound; with 0 errors it is ≈ 3/n (rule of three)
  const z = 1.96, ph = errors / n;
  const upper = (ph + z * z / (2 * n) + z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))) / (1 + z * z / n);
  return { rate: +(errors / n).toFixed(4), n, errors, upper95: +upper.toFixed(4) };
}

/**
 * Lowest bar t ∈ {0.50, 0.51, …, 1.00} at which the student's GOs agree with the teacher.
 * tolerance: fixed fraction of GO-side teacher "no"s to forgive (default 0 = fail-safe).
 * teacherErrorRate: forgive what a teacher with that flip rate would plausibly produce
 *   (allowedDisagreements(m, ε, alpha)); overrides `tolerance` when given.
 */
export function learnThreshold(samples, { minSamples = 8, minGo = 3, floor = null, minGoForDiscount = 0, tolerance = 0, teacherErrorRate: eps = null, alpha = 0.05 } = {}) {
  if (samples.length < minSamples) return { t: null, reason: "too few samples" };
  for (let i = 50; i <= 100; i++) {
    let t = i / 100;
    const go = samples.filter(([p]) => p >= t);
    const disagree = go.filter(([, y]) => !y).length;
    const allowed = eps !== null ? allowedDisagreements(go.length, eps, alpha) : Math.floor(tolerance * go.length);
    if (disagree > allowed) continue;
    if (go.length < minGo) return { t: null, reason: "no safe threshold with enough GOs" };
    // Earned discount: zero errors in a small bank is not proof of safety (rule of three:
    // n clean GOs bound the error rate at ~3/n). Below `floor` only with enough evidence.
    let capped = false;
    if (floor !== null && t < floor && go.length < minGoForDiscount) { t = floor; capped = true; }
    const yes = samples.filter(([, y]) => y).length;
    const goAtT = samples.filter(([p]) => p >= t).length;
    return { t, capped, cleanGo: goAtT, errorBound: goAtT ? +(3 / goAtT).toFixed(3) : null, recall: yes ? +(goAtT / yes).toFixed(3) : null };
  }
  return { t: null, reason: "never safe" };
}

export function senseStats(samples) {
  const n = samples.length || 1;
  const acc = samples.filter(([p, y]) => (p >= 0.5) === y).length / n;
  const brier = samples.reduce((s, [p, y]) => s + (p - (y ? 1 : 0)) ** 2, 0) / n;
  return { n: samples.length, acc: +acc.toFixed(3), brier: +brier.toFixed(4) };
}

/**
 * Teach: for every decided question in `ids`, run each sense on the same
 * evidence and bank (p, teacherLabel). Senses: { name: async ({question, node, files}) → p | {p}[] }.
 * Batch-capable senses may implement `batch(items)` → p[] to share one call.
 */
export async function teach(lattice, { ids, files, senses, bank, rules = null }) {
  const decided = ids
    .map(id => lattice.getNode(id))
    .filter(Boolean)
    .map(n => ({ n, g: lattice.evaluateGoNoGo(n.id) }))
    .filter(x => x.g.verdict === "GO" || x.g.verdict === "REFUTED");
  const out = { labelled: decided.length, senses: {} };
  await Promise.all(Object.entries(senses).map(async ([name, sense]) => {
    const items = decided.map(({ n }) => ({ question: n.text, node: n, files, rules }));
    let ps;
    try {
      ps = sense.batch ? await sense.batch(items) : await Promise.all(items.map(it => sense(it).catch(() => null)));
    } catch (e) {
      out.senses[name] = { error: e.message };
      return;
    }
    let banked = 0;
    const raw = [];
    for (const [i, { n, g }] of decided.entries()) {
      const p = ps[i];
      if (typeof p !== "number" || !Number.isFinite(p)) continue;
      await bank.add(n.text, name, [[+p.toFixed(4), g.verdict === "GO"]]);
      raw.push({ id: n.id, p, label: g.verdict === "GO" });
      banked++;
    }
    out.senses[name] = { banked, raw };
  }));
  return { ok: true, ...out };
}

/** Per question × sense: stats + learned threshold, straight from the bank. */
export async function senseReport(lattice, { ids, senseNames, bank, minSamples, minGo, floor, minGoForDiscount, tolerance, teacherErrorRate: eps = null }) {
  const rows = [];
  for (const id of ids) {
    const n = lattice.getNode(id);
    if (!n) continue;
    for (const s of senseNames) {
      const entry = await bank.get(n.text, s);
      const samples = entry?.samples || [];
      rows.push({ id, question: n.text, sense: s, ...senseStats(samples), learned: learnThreshold(samples, { minSamples, minGo, floor, minGoForDiscount, tolerance, teacherErrorRate: eps }) });
    }
  }
  return { ok: true, rows };
}

/**
 * The standard sense suite over a per-file evidence map. Any provider may be
 * null; its senses are then simply absent.
 *   jev-whole        Jev reading ALL files (blurrier sight)
 *   jev-paraphrase   Jev on a MiniMax paraphrase of the question, focused files
 *   workers-ai       on-edge small model, focused files
 *   compiled         sandboxed predicate registered for the question, focused files
 */
export function createSenseSuite({ jev = null, mm = null, small = null, predicates = null, store, rules = null }) {
  const bank = createLabelBank(store);
  const focused = (node, files) => {
    const reads = node.question_spec?.reads?.filter(p => p in files) || Object.keys(files);
    return Object.fromEntries(reads.map(p => [p, files[p]]));
  };
  const withRules = (st, r = rules) => (r ? { ...st, reading_rules: r } : st);

  async function paraphrase(question) {
    const k = `para:${await questionKey(question)}`;
    const hit = await store.get(k);
    if (hit) return hit.text;
    const { value } = await mm.json(`Rephrase this yes/no question so it asks exactly the same thing with different wording (same meaning, same polarity: "yes" must still mean the same). Question: ${question}\nReply with JSON {"text": "..."}`, { maxTokens: 1500, temperature: 0.7 });
    const text = String(value.text || question);
    await store.set(k, { text, of: question });
    return text;
  }

  const senses = {};
  if (jev) {
    senses["jev-whole"] = {
      batch: async items => {
        if (!items.length) return [];
        const ans = await jev.nouls(withRules({ files: items[0].files }, items[0].rules ?? rules), items.map((it, i) => ({ key: `q${i}`, instructions: it.question })));
        return items.map((_, i) => ans[`q${i}`]?.p);
      }
    };
  }
  if (jev && mm) {
    senses["jev-paraphrase"] = async ({ question, node, files, rules: r }) =>
      (await jev.noul(withRules({ files: focused(node, files) }, r ?? rules), await paraphrase(question))).p;
  }
  if (small) {
    senses["workers-ai"] = async ({ question, node, files, rules: r }) => {
      const rr = r ?? rules;
      const { value } = await small.json(`Evidence files (JSON): ${JSON.stringify(focused(node, files)).slice(0, 6000)}\n${rr ? `Reading rules: ${rr}\n` : ""}Question: ${question}\nReply with JSON {"probability_yes": number 0..1}.`, { maxTokens: 200, temperature: 0 });
      const p = Number(value.probability_yes);
      return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : null;
    };
  }
  if (predicates) {
    senses.compiled = async ({ question, node, files }) => {
      const entry = await predicates.get(question);
      if (!entry) return null;
      const text = Object.values(focused(node, files)).join("\n");
      const r = await predicates.run(entry, text);
      return r === null ? null : r ? 0.99 : 0.01;
    };
  }

  const pick = names => (names ? Object.fromEntries(Object.entries(senses).filter(([k]) => names.includes(k))) : senses);
  const questionIds = (lattice, ids) => ids || lattice.listNodes().filter(n => n.node_type === "QUESTION").map(n => n.id);

  return {
    names: Object.keys(senses),
    bank,
    /** Bank (p, teacher label) for every decided question. */
    teach: (lattice, { ids, files, senses: names, rules: r }) => teach(lattice, { ids: questionIds(lattice, ids), files, rules: r, senses: pick(names), bank }),
    report: (lattice, { ids, minSamples, minGo, floor, minGoForDiscount, tolerance, teacherErrorRate } = {}) => senseReport(lattice, { ids: questionIds(lattice, ids), senseNames: Object.keys(senses), bank, minSamples, minGo, floor, minGoForDiscount, tolerance, teacherErrorRate }),
    /** Run senses without a teacher; optionally append SENSE:<name> proofs. */
    async probe(lattice, { ids, files, senses: names, addProofs = false, rules: r }) {
      const nodes = questionIds(lattice, ids).map(id => lattice.getNode(id)).filter(Boolean);
      const out = {};
      await Promise.all(Object.entries(pick(names)).map(async ([name, sense]) => {
        const items = nodes.map(n => ({ question: n.text, node: n, files, rules: r }));
        const ps = sense.batch ? await sense.batch(items) : await Promise.all(items.map(it => sense(it).catch(() => null)));
        out[name] = {};
        nodes.forEach((n, i) => {
          const p = ps[i];
          if (typeof p !== "number" || !Number.isFinite(p)) return;
          out[name][n.id] = p;
          if (addProofs) lattice.addProof(n.id, { source_type: `SENSE:${name}`, provider: name, confidence: p, cost_weight: 0.1, note: "sense probe" });
        });
      }));
      return { ok: true, probes: out };
    },
    /**
     * Write what the bank learned into each question's spec: a learned bar per
     * sense (source_thresholds["SENSE:x"]), or block the sense where none is safe.
     */
    async apply(lattice, { ids, minSamples, minGo, floor, minGoForDiscount, tolerance, teacherErrorRate } = {}) {
      const rep = await senseReport(lattice, { ids: questionIds(lattice, ids), senseNames: Object.keys(senses), bank, minSamples, minGo, floor, minGoForDiscount, tolerance, teacherErrorRate });
      const applied = [];
      for (const row of rep.rows) {
        const n = lattice.getNode(row.id);
        const spec = n.question_spec;
        const src = `SENSE:${row.sense}`;
        spec.source_thresholds = { ...(spec.source_thresholds || {}) };
        spec.blocked_sources = (spec.blocked_sources || []).filter(s => s !== src);
        if (row.learned.t !== null) spec.source_thresholds[src] = row.learned.t;
        else { delete spec.source_thresholds[src]; spec.blocked_sources.push(src); }
        applied.push({ id: row.id, sense: row.sense, t: row.learned.t, n: row.n });
      }
      lattice._touch();
      return { ok: true, applied };
    }
  };
}
