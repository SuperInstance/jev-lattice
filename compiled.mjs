/**
 * Compiled predicates — the steady state of progressive compilation.
 *
 * A predicate is model-written code `(text) => boolean` for one question,
 * accepted only after it agrees with every *confident* teacher label (Jev
 * p ≥ 0.95 or ≤ 0.05). The scheduler runs predicates first and calls Jev only
 * for questions without an active predicate, plus a random spot-check that
 * catches predicates broken by input drift and quarantines them. Quarantined
 * predicates can be healed: recompiled with the counterexamples that broke them.
 *
 * Runtime-agnostic. Code execution is injected (`sandbox(code) → fn`, sync or
 * async), because node:vm is not a security boundary; in a Worker the sandbox
 * is a Dynamic Worker isolate (worker/predicates.mjs).
 */
import { extractJson } from "./providers/minimax.mjs";

export const COMPILED_COST_WEIGHT = 0.01;
const CONFIDENT = p => p >= 0.95 || p <= 0.05;

/**
 * Ask MiniMax for a predicate and validate it against confident labels.
 * @param {object} o
 * @param {{text:string, p:number}[]} o.labeled  teacher answers (unconfident ones are ignored)
 */
export async function compilePredicate({
  mm, question, rules, examples = [], labeled, sandbox, minLabels = 10, maxAttempts = 2, counterexamples = []
}) {
  const confident = labeled.filter(l => CONFIDENT(l.p));
  let feedback = counterexamples.length
    ? `A previous version was WRONG on these inputs (correct answer given):\n${counterexamples.slice(0, 4).map(c => `answer=${c.expected}\n${c.text}`).join("\n-----\n")}`
    : "";
  const out = { accepted: false, attempts: 0, confident: confident.length, disagreements: null, code: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    out.attempts = attempt;
    const res = await mm.chat(`Write a pure JavaScript arrow function \`(text) => boolean\` answering this yes/no question about a config file:
"${question}"
Reading rules: ${rules}
Use only string/regex/array methods; no require, no globals, no I/O. Handle every reading rule, not just the examples.
Example files:
${examples.slice(0, 3).join("\n-----\n")}
${feedback}
Reply with JSON {"code": "<the arrow function source>"}.`, { maxTokens: 8000, temperature: 0 });
    let fn, code;
    try {
      code = extractJson(res.text).code;
      fn = await sandbox(code);
    } catch (e) {
      feedback = `Your previous answer failed to compile: ${e.message}`;
      continue;
    }
    const bad = [];
    for (const l of confident) {
      let got;
      try { got = await fn(l.text); } catch { got = "threw"; }
      if (got !== l.p >= 0.95) bad.push({ text: l.text, expected: l.p >= 0.95, got });
    }
    out.disagreements = bad.length;
    out.code = code;
    if (bad.length === 0 && confident.length >= minLabels) {
      out.accepted = true;
      out.fn = fn;
      return out;
    }
    feedback = bad.length
      ? `Your previous function returned ${bad[0].got} but the correct answer is ${bad[0].expected} for:\n${bad[0].text}`
      : "Too few confident labels to validate; make the function robust anyway.";
  }
  return out;
}

export function createPredicateRegistry() {
  const entries = new Map(); // question → entry

  function register(question, { code, fn, meta = {} }) {
    const prev = entries.get(question);
    entries.set(question, {
      question, code, fn, status: "active", version: (prev?.version || 0) + 1, meta,
      stats: { runs: 0, throws: 0, spotChecks: 0, disagreements: 0 },
      counterexamples: prev?.counterexamples || [],
      history: prev?.history || []
    });
  }

  function quarantine(question, reason) {
    const e = entries.get(question);
    if (e && e.status === "active") {
      e.status = "quarantined";
      e.quarantinedReason = reason;
    }
  }

  /** Every confident teacher answer is kept: it is future validation data for healing. */
  function remember(question, text, p) {
    const e = entries.get(question);
    if (e && CONFIDENT(p)) e.history.push({ text, p });
  }

  return {
    entries,
    register,
    quarantine,
    remember,
    get: q => entries.get(q),
    active: q => (entries.get(q)?.status === "active" ? entries.get(q) : null),
    summary: () => [...entries.values()].map(e => ({ question: e.question, status: e.status, version: e.version, ...e.stats }))
  };
}

/**
 * Answer a batch of questions about one input, compiled-first.
 *
 *   active predicate          → answer from code (p = 0.99 / 0.01), no model call
 *   no predicate / quarantined / threw → Jev
 *   spot-check (rate ε)       → Jev for the whole batch too; a confident Jev answer that
 *                               disagrees with the predicate quarantines it
 *   trust: "refute-only"      → a predicate's NO is final, its YES is sent to Jev to confirm
 *                               (compiled code can never close a gate alone)
 * All Jev work for the batch is ONE fan-out call.
 *
 * Returns per-question { p, source, jevP? } and batch stats.
 */
export async function answerCompiledFirst({ registry, items, text, state, jev, spotCheck = false, trust = "both" }) {
  const res = {};
  const needJev = [];
  for (const it of items) {
    const e = registry.active(it.question);
    if (e) {
      e.stats.runs++;
      try {
        const yes = (await e.fn(text)) === true; // sandboxes may be async (Dynamic Workers RPC)
        res[it.key] = { p: yes ? 0.99 : 0.01, source: "compiled", version: e.version };
        // trust "refute-only": compiled code may say NO on its own; a YES must be confirmed by Jev
        if (trust === "refute-only" && yes) res[it.key].confirm = true;
        else if (!spotCheck) continue;
        e.stats.spotChecks++;
      } catch {
        e.stats.throws++;
        registry.quarantine(it.question, "threw on input");
        e.counterexamples.push({ text, expected: null });
      }
    }
    needJev.push(it);
  }
  let jevCall = null;
  if (needJev.length) {
    jevCall = await jev.nouls(state, needJev.map(it => ({ key: it.key, instructions: it.question })));
    for (const it of needJev) {
      const p = jevCall[it.key].p;
      registry.remember(it.question, text, p);
      const prior = res[it.key];
      if (prior?.confirm) {
        // the confirmer's answer is the answer; disagreement with a confident Jev still quarantines
        const e = registry.get(it.question);
        if (CONFIDENT(p) && p <= 0.05) {
          e.stats.disagreements++;
          e.counterexamples.push({ text, expected: false });
          registry.quarantine(it.question, "confirmation contradicted by confident Jev");
        }
        Object.assign(prior, { compiledP: prior.p, p, source: "compiled-yes→jev" });
      } else if (prior?.source === "compiled") {
        prior.jevP = p;
        const e = registry.get(it.question);
        if (CONFIDENT(p) && (p >= 0.95) !== (prior.p >= 0.5)) {
          e.stats.disagreements++;
          e.counterexamples.push({ text, expected: p >= 0.95 });
          registry.quarantine(it.question, "spot-check disagreement with confident Jev");
          // the confident teacher wins for this input; the predicate is out until healed
          Object.assign(prior, { disagreed: true, compiledP: prior.p, p, source: "jev-override" });
        }
      } else {
        res[it.key] = { p, source: "jev" };
      }
    }
  }
  return { answers: res, jevQuestions: needJev.length, jevCalls: needJev.length ? 1 : 0 };
}

/** Recompile every quarantined predicate with its counterexamples + remembered labels. */
export async function healQuarantined({ registry, mm, rules, sandbox, examples, minLabels = 10 }) {
  const out = [];
  for (const e of registry.entries.values()) {
    if (e.status !== "quarantined") continue;
    const r = await compilePredicate({
      mm, question: e.question, rules, examples, sandbox, minLabels,
      labeled: e.history,
      counterexamples: e.counterexamples.filter(c => c.expected !== null)
    });
    if (r.accepted) registry.register(e.question, { code: r.code, fn: r.fn, meta: { healed: true } });
    out.push({ question: e.question, healed: r.accepted, labels: r.confident, disagreements: r.disagreements });
  }
  return out;
}
