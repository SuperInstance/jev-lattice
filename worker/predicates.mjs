/**
 * Compiled predicates at the edge (backlog 6).
 *
 * Model-written `(text) => boolean` code runs in a Dynamic Worker isolate:
 * no bindings, no outbound network (globalOutbound: null), CPU-limited.
 * Isolates are cached by code hash (LOADER.get), so warm checks are an RPC.
 *
 * Trust policy (from experiments/compiled-first.mjs): teacher-validated code still
 * produced wrong GOs, so a compiled YES is emitted at YES_CONFIDENCE (0.8) —
 * below the default 0.85 gate — and can't close a gate alone unless the spec
 * opts in with source_thresholds.DETERMINISTIC_PARSER ≤ 0.8. A compiled NO is 0.01.
 */
import { sha256Hex, stateHash } from "../proof-cache.mjs";

export const YES_CONFIDENCE = 0.8;
export const NO_CONFIDENCE = 0.01;

function moduleSource(code) {
  return `import { WorkerEntrypoint } from "cloudflare:workers";
const fn = (${code});
export class Pred extends WorkerEntrypoint {
  async run(texts) {
    return texts.map(t => { try { return fn(t) === true; } catch (e) { return null; } });
  }
}`;
}

export function createEdgePredicates({ loader, storage }) {
  async function compileInIsolate(code) {
    const h = (await sha256Hex(code)).slice(0, 24);
    const stub = loader.get(`pred-${h}`, async () => ({
      compatibilityDate: "2026-09-01",
      mainModule: "p.js",
      modules: { "p.js": moduleSource(code) },
      globalOutbound: null,
      limits: { cpuMs: 50 }
    }));
    const ep = stub.getEntrypoint("Pred");
    return { hash: h, runMany: texts => ep.run(texts) };
  }

  const keyOf = async question => `pred:${(await sha256Hex(question)).slice(0, 24)}`;

  /**
   * Register only after the code agrees with every supplied label, executed in
   * the isolate itself (so acceptance is checked where it will run).
   */
  async function register({ question, code, labels = [], minLabels = 5 }) {
    if (!question || !code) return { ok: false, error: "question and code required" };
    if (labels.length < minLabels) return { ok: false, error: `need ≥ ${minLabels} labels {text, expected}` };
    let iso;
    try {
      iso = await compileInIsolate(code);
    } catch (e) {
      return { ok: false, error: `isolate rejected code: ${e.message}` };
    }
    const t0 = Date.now();
    let got;
    try {
      got = await iso.runMany(labels.map(l => l.text));
    } catch (e) {
      return { ok: false, error: `code failed to load or run: ${e.message}` };
    }
    const wrong = labels.filter((l, i) => got[i] !== (l.expected === true));
    if (wrong.length) {
      return { ok: false, accepted: false, disagreements: wrong.length, example: wrong[0] };
    }
    const key = await keyOf(question);
    const prev = await storage.get(key);
    const entry = { question, code, hash: iso.hash, version: (prev?.version || 0) + 1, labels: labels.length, registered_at: new Date().toISOString() };
    await storage.put(key, entry);
    return { ok: true, accepted: true, version: entry.version, hash: iso.hash, validate_ms: Date.now() - t0 };
  }

  async function get(question) {
    return storage.get(await keyOf(question));
  }

  /** Run a question's predicate on `text` and append the proof to node `nodeId`. */
  async function proof(lattice, nodeId, { text, question, channel = null }) {
    const n = lattice.getNode(nodeId);
    if (!n) return { ok: false, error: "node not found" };
    const q = question || n.text;
    const entry = await get(q);
    if (!entry) return { ok: false, error: "no predicate registered for this question" };
    const iso = await compileInIsolate(entry.code);
    const t0 = Date.now();
    const [answer] = await iso.runMany([text]);
    const latency_ms = Date.now() - t0;
    if (answer === null) return { ok: false, error: "predicate threw on this input", latency_ms };
    const added = lattice.addProof(nodeId, {
      source_type: "DETERMINISTIC_PARSER",
      provider: `compiled:v${entry.version}`,
      independence_key: `compiled:${entry.hash}`,
      confidence: answer ? YES_CONFIDENCE : NO_CONFIDENCE,
      cost_weight: 0.01,
      latency_ms,
      note: answer ? "compiled YES (hint; below default threshold)" : "compiled NO",
      evidence: { predicate: entry.hash, version: entry.version, state_hash: await stateHash(text), ...(channel ? { channel } : {}) }
    });
    return { ok: true, answer, latency_ms, proof: added.proof, gate: lattice.evaluateGoNoGo(nodeId) };
  }

  /** Run a stored predicate on text → true | false | null (threw). */
  async function run(entry, text) {
    const iso = await compileInIsolate(entry.code);
    const [answer] = await iso.runMany([text]);
    return answer;
  }

  return { register, get, proof, run };
}
