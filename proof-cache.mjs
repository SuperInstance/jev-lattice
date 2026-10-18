/**
 * Proof cache — content-addressed verifier answers.
 *
 * Key = provider | model | hash(state) | hash(question). Two reasons to cache:
 *   1. cost: re-checking an unchanged gate costs nothing
 *   2. reproducibility: Jev is not bit-deterministic (same input → p varies by
 *      up to ~0.1; ~7% of gates flip GO↔OPEN at t=0.9 on re-ask). Caching the
 *      first answer makes "same evidence ⇒ same verdict" hold.
 *
 * State is canonicalized (object keys sorted) before hashing AND before it is
 * sent, so the cache key and the model input are the same bytes. Key order
 * measurably changes Jev's answer, so this is a semantic choice, not cosmetics.
 *
 * Runtime-agnostic: WebCrypto only (Node ≥ 20, browsers, Workers).
 */

/** Stable JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
}

export async function sha256Hex(str) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 128-bit content hash of a System One state. */
export async function stateHash(state, { canonical = true } = {}) {
  return (await sha256Hex(canonical ? canonicalize(state) : JSON.stringify(state))).slice(0, 32);
}

/** In-memory store with the async interface every store implements. */
export function memoryStore() {
  const m = new Map();
  return {
    async get(k) { return m.get(k); },
    async getMany(keys) { return new Map(keys.filter(k => m.has(k)).map(k => [k, m.get(k)])); },
    async set(k, v) { m.set(k, v); },
    async setMany(entries) { for (const [k, v] of entries) m.set(k, v); },
    async delete(k) { m.delete(k); },
    get size() { return m.size; }
  };
}

/**
 * Durable Object storage adapter (ctx.storage). Batches respect the 128-key
 * limit of get/put.
 */
export function durableObjectStore(storage, prefix = "cache:") {
  const chunk = (a, n = 128) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  return {
    async get(k) { return storage.get(prefix + k); },
    async getMany(keys) {
      const out = new Map();
      for (const c of chunk(keys)) {
        const got = await storage.get(c.map(k => prefix + k));
        for (const [k, v] of got) out.set(k.slice(prefix.length), v);
      }
      return out;
    },
    async set(k, v) { await storage.put(prefix + k, v); },
    async setMany(entries) {
      for (const c of chunk(entries)) await storage.put(Object.fromEntries(c.map(([k, v]) => [prefix + k, v])));
    },
    async delete(k) { await storage.delete(prefix + k); }
  };
}

/**
 * @param {object} o
 * @param {ReturnType<typeof memoryStore>} [o.store]
 * @param {number|null} [o.ttlMs]  entries older than this are misses. Model aliases
 *   like `jev-latest` move; a TTL bounds how long an old model's answer is served.
 */
export function createProofCache({ store = memoryStore(), ttlMs = null, now = () => Date.now() } = {}) {
  const stats = { hits: 0, misses: 0, expired: 0, writes: 0 };
  const fresh = e => e && (!ttlMs || now() - e.at <= ttlMs);

  async function keyFor({ provider, model, state_hash, instructions, criteria }) {
    const q = await sha256Hex(canonicalize({ instructions, criteria: criteria ?? null }));
    return `${provider}|${model}|${state_hash}|${q.slice(0, 32)}`;
  }

  async function getMany(keys) {
    const got = await store.getMany(keys);
    const out = new Map();
    for (const k of keys) {
      const e = got.get(k);
      if (fresh(e)) { out.set(k, e); stats.hits++; }
      else { if (e) stats.expired++; stats.misses++; }
    }
    return out;
  }

  async function setMany(entries) {
    const stamped = entries.map(([k, v]) => [k, { ...v, at: now() }]);
    await store.setMany(stamped);
    stats.writes += stamped.length;
  }

  return { keyFor, getMany, setMany, stats, store, ttlMs };
}

/**
 * Wrap a Jev client: same noul/nouls interface, answers served from cache when
 * the (state, question) pair was seen, misses batched into ONE request.
 * Results carry `state_hash` and per-question `cached` so proofs can record them.
 */
export function cachedJev(jev, cache, { canonicalState = true } = {}) {
  async function nouls(state, items) {
    const sent = canonicalState ? JSON.parse(canonicalize(state)) : state;
    const h = await stateHash(state, { canonical: canonicalState });
    const keys = await Promise.all(items.map(it =>
      cache.keyFor({ provider: "typesafe", model: jev.model, state_hash: h, instructions: it.instructions, criteria: it.criteria })
    ));
    const hits = await cache.getMany(keys);
    const missing = items.filter((_, i) => !hits.has(keys[i]));
    const t0 = Date.now();
    let fresh = null;
    if (missing.length) {
      fresh = await jev.nouls(sent, missing);
      await cache.setMany(missing.map(it => [keys[items.indexOf(it)], { p: fresh[it.key].p, model: fresh._model }]));
    }
    const out = {
      _model: fresh?._model ?? hits.values().next().value?.model ?? jev.model,
      _latency_ms: Date.now() - t0,
      _usage: fresh?._usage ?? { input_tokens: 0, output_tokens: 0 },
      _cache: { hits: items.length - missing.length, misses: missing.length },
      _state_hash: h
    };
    items.forEach((it, i) => {
      const e = hits.get(keys[i]);
      out[it.key] = e ? { p: e.p, cached: true, model: e.model, ...(e.spread !== undefined ? { spread: e.spread } : {}) } : { p: fresh[it.key].p, cached: false };
    });
    return out;
  }

  async function noul(state, instructions, criteria) {
    const r = await nouls(state, [{ key: "q", instructions, criteria }]);
    return { p: r.q.p, model: r.q.model || r._model, latency_ms: r._latency_ms, cached: r.q.cached, spread: r.q.spread, state_hash: r._state_hash };
  }

  return { ...jev, noul, nouls, cache, canonicalState, provider: "typesafe" };
}

/**
 * Stability probe (T34): re-ask the SAME questions against the SAME state n times,
 * bypassing the cache, and record the spread (max − min) per question. Written back
 * onto the cache entry, so later proofs served from the cache carry the measured
 * noise and the gate can tell a firm 0.97 from a fragile 0.91.
 * `jev` must be the raw client (not cachedJev); `cache` is optional.
 */
export async function stabilityProbe(jev, state, items, { n = 5, cache = null, canonicalState = true } = {}) {
  const sent = canonicalState ? JSON.parse(canonicalize(state)) : state;
  const runs = await Promise.all(Array.from({ length: n }, () => jev.nouls(sent, items)));
  const out = {};
  for (const it of items) {
    const ps = runs.map(r => r[it.key]?.p).filter(p => typeof p === "number");
    const mean = ps.reduce((a, b) => a + b, 0) / (ps.length || 1);
    out[it.key] = { samples: ps, mean: +mean.toFixed(4), spread: +(Math.max(...ps) - Math.min(...ps)).toFixed(4) };
  }
  if (cache) {
    const h = await stateHash(state, { canonical: canonicalState });
    for (const it of items) {
      const key = await cache.keyFor({ provider: "typesafe", model: jev.model, state_hash: h, instructions: it.instructions, criteria: it.criteria });
      const prev = (await cache.store.getMany([key])).get(key);
      if (prev) await cache.store.setMany([[key, { ...prev, spread: out[it.key].spread, probe_n: n }]]);
    }
  }
  return out;
}
