/**
 * Per-source confidence calibration (backlog 3).
 *
 * A gate threshold only means something if a source's 0.9 is right ~90% of
 * the time. Fit a monotone map raw-p → empirical P(true) per source on labelled
 * data, then apply it when the proof is created. Monotone ⇒ ranking preserved;
 * an overconfident source (llama: p=1 on wrong answers) gets pulled down to
 * what its 1.0 is actually worth.
 *
 * Runtime-agnostic, no dependencies. Maps are plain JSON (portable like state).
 */

/**
 * Isotonic regression by pool-adjacent-violators on (p, y) pairs.
 * Returns a JSON map { knots: [[p, value], ...], n } — piecewise-constant,
 * evaluated by the last knot whose p ≤ x.
 * `prior` adds pseudo-counts toward 0.5 per block so tiny blocks can't claim certainty.
 */
export function fitIsotonic(rows, { prior = 1 } = {}) {
  const pts = rows
    .filter(r => Number.isFinite(r.p))
    .map(r => ({ p: r.p, y: r.truth ? 1 : 0 }))
    .sort((a, b) => a.p - b.p);
  // group identical p first so ties form one block
  const blocks = [];
  for (const pt of pts) {
    const last = blocks.at(-1);
    if (last && last.lo === pt.p) { last.sum += pt.y; last.n++; }
    else blocks.push({ lo: pt.p, sum: pt.y, n: 1 });
  }
  const val = b => (b.sum + 0.5 * prior) / (b.n + prior);
  const stack = [];
  for (const b of blocks) {
    stack.push({ ...b });
    while (stack.length > 1 && val(stack.at(-2)) > val(stack.at(-1))) {
      const top = stack.pop();
      const prev = stack.at(-1);
      prev.sum += top.sum;
      prev.n += top.n;
    }
  }
  return { kind: "isotonic", n: pts.length, prior, knots: stack.map(b => [b.lo, +val(b).toFixed(4), b.n]) };
}

/** Apply a fitted map to a raw probability. Unknown map → identity. */
export function calibrate(map, p) {
  if (!map?.knots?.length || !Number.isFinite(p)) return p;
  let v = map.knots[0][1];
  for (const [lo, value] of map.knots) {
    if (p >= lo) v = value;
    else break;
  }
  return v;
}

/** Calibrate a proof in place-free fashion: keeps the raw reading for audit. */
export function calibrateProof(proof, maps) {
  const map = maps?.[proof.provider] || maps?.[proof.source_type];
  if (!map) return proof;
  return {
    ...proof,
    confidence: calibrate(map, proof.confidence),
    evidence: { ...(proof.evidence || {}), raw_confidence: proof.confidence, calibration: `${map.kind}/n=${map.n}` }
  };
}

/** Standard reliability metrics. */
export function reliability(rows, thresholds = [0.8, 0.9, 0.95]) {
  const n = rows.length || 1;
  const brier = rows.reduce((s, r) => s + (r.p - (r.truth ? 1 : 0)) ** 2, 0) / n;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const r of rows) {
    const b = bins[Math.min(9, Math.floor(r.p * 10))];
    b.n++; b.p += r.p; b.y += r.truth ? 1 : 0;
  }
  const ece = bins.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  const gate = {};
  for (const t of thresholds) {
    const go = rows.filter(r => r.p >= t);
    gate[t] = { go: go.length, wrongGo: go.filter(r => !r.truth).length, recall: +(go.filter(r => r.truth).length / (rows.filter(r => r.truth).length || 1)).toFixed(3) };
  }
  return { n: rows.length, brier: +brier.toFixed(4), ece: +ece.toFixed(4), gate };
}
