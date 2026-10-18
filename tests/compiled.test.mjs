/**
 * Compiled-predicate scheduler — offline, with fake MiniMax/Jev and plain-JS "sandbox".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePredicate, createPredicateRegistry, answerCompiledFirst, healQuarantined } from "../compiled.mjs";

// The "sandbox" here is new Function over trusted test code only.
const sandbox = code => { const fn = new Function(`return (${code})`)(); return t => fn(t) === true; };
const fakeMM = codes => { let i = 0; return { async chat() { return { text: JSON.stringify({ code: codes[Math.min(i++, codes.length - 1)] }) }; } }; };
function fakeJev(answer) {
  const seen = { calls: 0, questions: 0 };
  return {
    seen,
    async nouls(state, items) {
      seen.calls++;
      seen.questions += items.length;
      const out = { _model: "fake" };
      for (const it of items) out[it.key] = { p: answer(state, it.instructions) };
      return out;
    }
  };
}
const Q = "Is TLS on?";
const TRUE_TLS = "t => /tls-port/i.test(t)";
const BROKEN = "t => t.includes('tls-port')"; // misses uppercase
const labeled = [
  ...Array.from({ length: 6 }, () => ({ text: "tls-port 6380", p: 0.99 })),
  ...Array.from({ length: 6 }, () => ({ text: "port 6379", p: 0.01 })),
  { text: "ambiguous", p: 0.5 }
];

test("compilePredicate retries with a counterexample and accepts on zero disagreements", async () => {
  const r = await compilePredicate({ mm: fakeMM(["t => false", TRUE_TLS]), question: Q, rules: "", labeled, sandbox, minLabels: 10 });
  assert.equal(r.accepted, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.confident, 12, "the 0.5 label is ignored");
});

test("compilePredicate rejects when there are too few confident labels", async () => {
  const r = await compilePredicate({ mm: fakeMM([TRUE_TLS]), question: Q, rules: "", labeled: labeled.slice(0, 4), sandbox, minLabels: 10, maxAttempts: 1 });
  assert.equal(r.accepted, false);
  assert.equal(r.disagreements, 0);
});

test("compiled-first: active predicates answer without calling Jev", async () => {
  const reg = createPredicateRegistry();
  reg.register(Q, { code: TRUE_TLS, fn: sandbox(TRUE_TLS) });
  const jev = fakeJev(() => 0.5);
  const r = await answerCompiledFirst({ registry: reg, items: [{ key: "a", question: Q }, { key: "b", question: "Other?" }], text: "tls-port 1", state: "s", jev });
  assert.equal(r.answers.a.source, "compiled");
  assert.equal(r.answers.b.source, "jev");
  assert.equal(jev.seen.questions, 1, "only the uncompiled question went to Jev");
});

test("spot-check disagreement quarantines the predicate and the teacher's answer wins", async () => {
  const reg = createPredicateRegistry();
  reg.register(Q, { code: BROKEN, fn: sandbox(BROKEN) });
  const jev = fakeJev(s => (/tls-port/i.test(s) ? 0.99 : 0.01));
  const r = await answerCompiledFirst({ registry: reg, items: [{ key: "a", question: Q }], text: "TLS-PORT 6380", state: "TLS-PORT 6380", jev, spotCheck: true });
  assert.equal(r.answers.a.source, "jev-override");
  assert.equal(r.answers.a.p, 0.99);
  assert.equal(reg.get(Q).status, "quarantined");
  // quarantined → Jev answers from now on
  const r2 = await answerCompiledFirst({ registry: reg, items: [{ key: "a", question: Q }], text: "tls-port 1", state: "tls-port 1", jev });
  assert.equal(r2.answers.a.source, "jev");
});

test("refute-only: compiled NO is final, compiled YES goes to Jev", async () => {
  const reg = createPredicateRegistry();
  const ALWAYS_YES = "t => true";
  reg.register(Q, { code: ALWAYS_YES, fn: sandbox(ALWAYS_YES) });
  reg.register("Never?", { code: "t => false", fn: sandbox("t => false") });
  const jev = fakeJev(() => 0.01);
  const r = await answerCompiledFirst({
    registry: reg, items: [{ key: "a", question: Q }, { key: "b", question: "Never?" }], text: "port 1", state: "port 1", jev, trust: "refute-only"
  });
  assert.equal(r.answers.a.source, "compiled-yes→jev");
  assert.equal(r.answers.a.p, 0.01, "a wrong compiled YES cannot become a GO");
  assert.equal(r.answers.b.source, "compiled");
  assert.equal(jev.seen.questions, 1);
  assert.equal(reg.get(Q).status, "quarantined", "confidently contradicted YES quarantines");
});

test("a predicate that throws is quarantined and Jev answers", async () => {
  const reg = createPredicateRegistry();
  const THROWS = "t => { throw new Error('x') }";
  reg.register(Q, { code: THROWS, fn: (() => { const f = sandbox(THROWS); return f; })() });
  const jev = fakeJev(() => 0.97);
  const r = await answerCompiledFirst({ registry: reg, items: [{ key: "a", question: Q }], text: "x", state: "x", jev });
  assert.equal(r.answers.a.source, "jev");
  assert.equal(reg.get(Q).status, "quarantined");
});

test("healQuarantined recompiles from counterexamples + remembered labels", async () => {
  const reg = createPredicateRegistry();
  reg.register(Q, { code: BROKEN, fn: sandbox(BROKEN) });
  const jev = fakeJev(s => (/tls-port/i.test(s) ? 0.99 : 0.01));
  for (const text of ["tls-port 1", "port 2", "tls-port 3", "port 4", "tls-port 5", "port 6"]) {
    await answerCompiledFirst({ registry: reg, items: [{ key: "a", question: Q }], text, state: text, jev, spotCheck: true });
  }
  await answerCompiledFirst({ registry: reg, items: [{ key: "a", question: Q }], text: "TLS-PORT 9", state: "TLS-PORT 9", jev, spotCheck: true });
  assert.equal(reg.get(Q).status, "quarantined");
  const h = await healQuarantined({ registry: reg, mm: fakeMM([TRUE_TLS]), rules: "", sandbox, examples: [], minLabels: 6 });
  assert.equal(h[0].healed, true);
  assert.equal(reg.get(Q).status, "active");
  assert.equal(reg.get(Q).version, 2);
  assert.equal(reg.get(Q).fn("TLS-PORT 1"), true);
});
