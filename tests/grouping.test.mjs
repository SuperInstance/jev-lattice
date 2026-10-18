import test from "node:test";
import assert from "node:assert/strict";
import { groupCandidates, proposeGroups, validateGroups, createGroupedAsker } from "../grouping.mjs";

const questions = [
  { key: "a", text: "Is LOG_LEVEL debug?", reads: ["app.env"] },
  { key: "b", text: "Is LOG_LEVEL info or warn?", reads: ["app.env"] },
  { key: "c", text: "Is SENTRY_DSN set?", reads: ["app.env"] }
];
const level = s => /LOG_LEVEL=(\w+)/.exec(s["app.env"])?.[1] ?? "unset";
// fake Jev: Nouls answer by code; the Choice reports the level
const fakeJev = { calls: 0, async ask(state, qs) {
  this.calls++;
  const answers = {};
  for (const [k, q] of Object.entries(qs)) {
    if (q.type === "choice") answers[k] = { probabilities: Object.fromEntries(Object.keys(q.criteria).map(o => [o, o === level(state) ? 0.99 : 0.01 / (Object.keys(q.criteria).length - 1)])), choice: level(state) };
    else answers[k] = { noul: q.instructions.includes("debug") ? (level(state) === "debug" ? 0.99 : 0.01) : q.instructions.includes("info") ? (["info", "warn"].includes(level(state)) ? 0.99 : 0.01) : 0.5 };
  }
  return { answers, model: "fake" };
} };
const mmWith = groups => ({ async json() { return { value: { groups } }; } });
const LEVELS = { instructions: "What is LOG_LEVEL?", criteria: { debug: "debug", info: "info", warn: "warn", unset: "not set" } };

test("groupCandidates buckets by shared file", () => {
  assert.equal(groupCandidates(questions).length, 1);
  assert.equal(groupCandidates(questions, { minShared: 4 }).length, 0);
});

test("propose → validate → ask: correct mappings accepted, wrong one rejected, fewer questions", async () => {
  const groups = await proposeGroups({ mm: mmWith([
    { choice: LEVELS, derived: [{ key: "a", allowed: ["debug"] }, { key: "b", allowed: ["info", "warn"] }] },
    { choice: { instructions: "What is LOG_LEVEL (again)?", criteria: LEVELS.criteria }, derived: [{ key: "a", allowed: ["warn"] }] }, // wrong
    { choice: { instructions: "bogus" }, derived: [] }, // malformed: dropped
    { choice: LEVELS, derived: [{ key: "zzz", allowed: ["debug"] }] } // unknown key: dropped
  ]), questions });
  assert.equal(groups.length, 2);
  const states = ["debug", "info", "warn"].flatMap(l => Array.from({ length: 4 }, () => ({ "app.env": `LOG_LEVEL=${l}` })));
  const { accepted, report } = await validateGroups({ jev: fakeJev, questions, groups, states, minAgree: 10 });
  assert.deepEqual(Object.keys(accepted).sort(), ["a", "b"]);
  assert.equal(accepted.a.group, 0);
  const asker = createGroupedAsker({ jev: fakeJev, questions, groups, accepted });
  assert.equal(asker.questionsPerState, 2, "1 choice + 1 remaining noul instead of 3 nouls");
  const r = await asker.ask({ "app.env": "LOG_LEVEL=warn" });
  assert.ok(r.p.a < 0.05 && r.p.b > 0.95);
  assert.equal(r.source.c, "noul");
  assert.ok(report.a.ok);
});
