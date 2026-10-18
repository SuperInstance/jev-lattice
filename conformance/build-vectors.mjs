// Hand-written gate cases with hand-computed expectations (docs/GATE-SEMANTICS.md).
// `node conformance/build-vectors.mjs` writes gate-vectors.json; the expectations are NOT
// produced by running the reference implementation — tests/conformance.test.mjs checks it.
import fs from "node:fs";
const NOW = "2026-01-01T00:00:00.000Z";
const T = "2025-12-31T23:00:00.000Z"; // one hour before NOW
const P = (source_type, confidence, extra = {}) => ({ proof_id: `${source_type}-${confidence}-${Object.keys(extra).join("")}`, source_type, confidence, timestamp: T, ...extra });
const v = (name, section, spec, proofs, expect) => ({ name, section, question_spec: spec, active_proofs: proofs, expect });
const vectors = [
  v("no spec, no proofs", "1.1", null, [], { verdict: "OPEN", go: false, threshold: 0.85, margin: null, fragile: false }),
  v("binary GO", "2.7", {}, [P("PARSER", 0.95)], { verdict: "GO", go: true, margin: 0.1, fragile: false }),
  v("binary GO inside the fragility band", "2.9", {}, [P("PARSER", 0.86)], { verdict: "GO", go: true, margin: 0.01, fragile: true }),
  v("confidence 0 is preserved and refutes", "1.2", {}, [P("PARSER", 0)], { verdict: "REFUTED", go: false, margin: 0.15, fragile: false }),
  v("threshold 0: one reading both supports and refutes", "2.5", { confidence_threshold: 0 }, [P("PARSER", 0.3)], { verdict: "CONFLICT", go: false }),
  v("same path twice: latest wins, not max", "2.3", {}, [P("PARSER", 0.95), P("PARSER", 0.5, { n: 2 })], { verdict: "OPEN", go: false, margin: -0.35, fragile: false }),
  v("a re-read clears its own refutation", "4.2", {}, [P("PARSER", 0.1), P("PARSER", 0.95, { n: 2 })], { verdict: "GO", go: true, margin: 0.1 }),
  v("coordinated: required-th best path decides", "2.8", { evaluation_mode: "COORDINATED", required_independent_proofs: 2 }, [P("PARSER", 0.99), P("LLM", 0.9)], { verdict: "GO", go: true, margin: 0.05, fragile: false }),
  v("coordinated: one of two paths is OPEN", "2.7", { evaluation_mode: "COORDINATED", required_independent_proofs: 2 }, [P("PARSER", 0.99)], { verdict: "OPEN", go: false, margin: 0.14, fragile: false }),
  v("binary ignores required_independent_proofs", "2.6", { required_independent_proofs: 3 }, [P("PARSER", 0.99)], { verdict: "GO", go: true, required: 1 }),
  v("invalidated proofs are ignored", "2.2", {}, [P("PARSER", 0.99, { invalidated: true })], { verdict: "OPEN", go: false, margin: null }),
  v("expired proofs are ignored", "2.2", { max_proof_age_ms: 1000 }, [P("PARSER", 0.99)], { verdict: "OPEN", go: false, margin: null }),
  v("fresh proofs within max age count", "2.2", { max_proof_age_ms: 7200000 }, [P("PARSER", 0.99)], { verdict: "GO", go: true }),
  v("unparseable timestamp drops the proof when age is limited", "2.2", { max_proof_age_ms: 7200000 }, [{ ...P("PARSER", 0.99), timestamp: "yesterday-ish" }], { verdict: "OPEN", go: false }),
  v("disallowed source is ignored", "2.2", { allowed_sources: ["PARSER"] }, [P("LLM", 0.99)], { verdict: "OPEN", go: false }),
  v("blocked source is ignored", "2.2", { blocked_sources: ["LLM"] }, [P("LLM", 0.99), P("PARSER", 0.9)], { verdict: "GO", go: true, margin: 0.05 }),
  v("per-source bar applies to support", "2.4", { source_thresholds: { LLM: 0.95 } }, [P("LLM", 0.9)], { verdict: "OPEN", go: false }),
  v("per-source bar applies to refutation", "2.4", { source_thresholds: { LLM: 0.95 } }, [P("LLM", 0.07)], { verdict: "OPEN", go: false }),
  v("conflict blocks GO", "2.7", {}, [P("PARSER", 0.99), P("LLM", 0.05)], { verdict: "CONFLICT", go: false }),
  v("block_on_conflict false lets GO through", "2.7", { block_on_conflict: false }, [P("PARSER", 0.99), P("LLM", 0.05)], { verdict: "CONFLICT", go: true }),
  v("measured spread widens the fragility band", "2.9", {}, [P("PARSER", 0.95, { evidence: { spread: 0.2 } })], { verdict: "GO", go: true, margin: 0.1, fragile: true }),
  v("custom fragility band", "2.9", { fragility_band: 0.15 }, [P("PARSER", 0.95)], { verdict: "GO", fragile: true }),
  v("require_firm holds a fragile GO", "2.10", { require_firm: true }, [P("PARSER", 0.86)], { verdict: "OPEN", go: false, needs_corroboration: true, held: "GO" }),
  v("require_firm: a firm GO passes", "2.10", { require_firm: true }, [P("PARSER", 0.95)], { verdict: "GO", go: true }),
  v("require_firm: a second supporting path corroborates", "2.10", { require_firm: true }, [P("PARSER", 0.86), P("LLM", 0.9)], { verdict: "GO", go: true }),
  v("provider separates paths of the same source type", "2.3", { evaluation_mode: "COORDINATED", required_independent_proofs: 2 }, [P("LLM", 0.95, { provider: "a" }), P("LLM", 0.95, { provider: "b" })], { verdict: "GO", go: true, paths: 2 }),
  v("independence_key overrides provider", "2.3", { evaluation_mode: "COORDINATED", required_independent_proofs: 2 }, [P("LLM", 0.95, { provider: "a", independence_key: "k" }), P("LLM", 0.95, { provider: "b", independence_key: "k" })], { verdict: "OPEN", go: false, paths: 1 })
];
fs.writeFileSync(new URL("./gate-vectors.json", import.meta.url), JSON.stringify({ schema: "jev-gate-vectors/1", now: NOW, vectors }, null, 2) + "\n");
console.log(`${vectors.length} vectors`);
