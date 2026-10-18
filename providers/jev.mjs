#!/usr/bin/env node
/**
 * TypeSafe Jev provider — System One model with calibrated typed answers.
 *
 * Jev is the cheap, fast verifier in the lattice: a Noul answer is the
 * calibrated probability that a yes/no question is true given `state`,
 * which maps 1:1 onto a proof's `confidence`.
 *
 * Works in Node >=18, browsers, and Cloudflare Workers (fetch only).
 *
 * CLI:
 *   TYPESAFE_AI_TOKEN=... node providers/jev.mjs '<state string or JSON>' "Yes/no question?"
 */

export const JEV_DEFAULT_MODEL = "jev-latest";
const DEFAULT_BASE = "https://api.typesafe.ai/v1";
/** Jev is ~an order of magnitude cheaper than a CoT LLM call; used for path cost bias. */
export const JEV_COST_WEIGHT = 0.05;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createJev({
  apiKey = globalThis.process?.env?.TYPESAFE_AI_TOKEN,
  model = globalThis.process?.env?.JEV_MODEL || JEV_DEFAULT_MODEL, // pin in production, e.g. jev-1.13.0
  baseUrl = DEFAULT_BASE,
  fetchImpl = globalThis.fetch,
  maxRetries = 4,
  timeoutMs = 60000,
  // 262k per-request/per-question context instead of 64k/32k (TypeSafe long-context header)
  longContext = false
} = {}) {
  if (!apiKey) throw new Error("Jev: missing api key (TYPESAFE_AI_TOKEN)");
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, questions: 0 };

  /**
   * Raw System One call. `questions` is a map id → {type, instructions, criteria?}.
   * Retries 429/529/5xx with exponential backoff as the API docs recommend.
   */
  async function ask(state, questions, { model: m = model } = {}) {
    const body = JSON.stringify({ state, model: m, questions });
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/systemone`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(longContext ? { "TypeSafe-Danger-Zone-Long-Context": "true" } : {})
          },
          body,
          signal: ctrl.signal
        });
      } catch (e) {
        lastErr = e;
        await sleep(500 * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastErr = new Error(`Jev transient ${res.status}`);
        const ra = Number(res.headers.get?.("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`Jev error ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
        err.status = res.status;
        throw err;
      }
      usage.calls++;
      usage.questions += Object.keys(questions).length;
      usage.input_tokens += data.usage?.input_tokens || 0;
      usage.output_tokens += data.usage?.output_tokens || 0;
      return data;
    }
    throw lastErr;
  }

  /** One yes/no question → probability of yes. */
  async function noul(state, instructions, criteria) {
    const q = { type: "noul", instructions };
    if (criteria) q.criteria = criteria;
    const t0 = Date.now();
    const data = await ask(state, { q });
    return { p: data.answers.q.noul, model: data.model, latency_ms: Date.now() - t0, usage: data.usage };
  }

  /**
   * Speculative fan-out: many yes/no questions in one request.
   * `items` = [{ key, instructions, criteria? }] → { key: {p} , _model, _latency_ms }
   */
  async function nouls(state, items) {
    const questions = {};
    for (const it of items) {
      questions[it.key] = { type: "noul", instructions: it.instructions };
      if (it.criteria) questions[it.key].criteria = it.criteria;
    }
    const t0 = Date.now();
    const data = await ask(state, questions);
    const out = { _model: data.model, _latency_ms: Date.now() - t0, _usage: data.usage };
    for (const it of items) out[it.key] = { p: data.answers[it.key]?.noul };
    return out;
  }

  async function choice(state, instructions, criteria) {
    const data = await ask(state, { q: { type: "choice", instructions, criteria } });
    return { ...data.answers.q, model: data.model };
  }

  async function score(state, instructions, criteria) {
    const data = await ask(state, { q: { type: "score", instructions, criteria } });
    return { ...data.answers.q, model: data.model };
  }

  async function models() {
    const res = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return res.json();
  }

  return { ask, noul, nouls, choice, score, models, usage, model, longContext, provider: "typesafe" };
}

/** Convert a Noul result into a lattice proof. */
export function noulToProof(
  { p, model, latency_ms, cached, spread },
  { note = null, instructions = null, state_hash = null, channel = null } = {}
) {
  const evidence = {};
  if (instructions) evidence.instructions = instructions;
  // state_hash + channel let drift invalidation kill exactly the proofs whose evidence changed
  if (state_hash) evidence.state_hash = state_hash;
  if (channel) evidence.channel = channel;
  if (cached) evidence.cached = true;
  // measured re-ask spread (stability probe) — lets the gate flag fragile verdicts
  if (typeof spread === "number") evidence.spread = spread;
  return {
    source_type: "JEV_NOUL",
    provider: "typesafe",
    model: model || JEV_DEFAULT_MODEL,
    confidence: p,
    cost_weight: JEV_COST_WEIGHT,
    latency_ms,
    note,
    evidence: Object.keys(evidence).length ? evidence : undefined
  };
}

/**
 * Choice → yes/no proof: P(answer ∈ allowed) = Σ probabilities of the allowed options.
 * One Choice question can back several gates ("is it loopback?", "is it public?").
 */
export function choiceToProof(answer, allowed, { model, note = null, state_hash = null, channel = null } = {}) {
  const probs = answer.probabilities || {};
  const p = Math.min(1, allowed.reduce((s, k) => s + (Number(probs[k]) || 0), 0));
  return {
    ...noulToProof({ p, model }, { note, state_hash, channel }),
    source_type: "JEV_CHOICE",
    evidence: { ...(state_hash ? { state_hash } : {}), ...(channel ? { channel } : {}), allowed, choice: answer.choice, choice_confidence: answer.confidence }
  };
}

/** Score → yes/no proof: P(level ≥ minLevel) = Σ probabilities of levels at or above it. */
export function scoreToProof(answer, minLevel, { model, note = null, state_hash = null, channel = null } = {}) {
  const probs = answer.probabilities || {};
  const p = Math.min(1, Object.entries(probs).filter(([lvl]) => Number(lvl) >= minLevel).reduce((s, [, v]) => s + (Number(v) || 0), 0));
  return {
    ...noulToProof({ p, model }, { note, state_hash, channel }),
    source_type: "JEV_SCORE",
    evidence: { ...(state_hash ? { state_hash } : {}), ...(channel ? { channel } : {}), minLevel, score: answer.score, score_confidence: answer.confidence }
  };
}

// ---------- CLI ----------
const isMain = globalThis.process?.argv?.[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [stateArg, question] = process.argv.slice(2);
  if (!stateArg || !question) {
    console.error('usage: node providers/jev.mjs "<state>" "<yes/no question>"');
    process.exit(2);
  }
  let state = stateArg;
  try { state = JSON.parse(stateArg); } catch {}
  const jev = createJev();
  console.log(JSON.stringify(await jev.noul(state, question), null, 2));
}
