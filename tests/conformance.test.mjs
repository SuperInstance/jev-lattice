// Runs conformance/gate-vectors.json against the reference implementation.
// Other implementations should run the same file: build one QUESTION node per vector,
// evaluate at `now`, and compare the listed fields (margin to 4 decimals).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JEVLattice } from "../jev-core.js";

const { now, vectors } = JSON.parse(fs.readFileSync(new URL("../conformance/gate-vectors.json", import.meta.url)));
for (const vec of vectors) {
  test(`conformance §${vec.section}: ${vec.name}`, () => {
    const l = new JEVLattice();
    const node = { id: "q", node_type: "QUESTION", text: vec.name, active_proofs: vec.active_proofs };
    if (vec.question_spec) node.question_spec = vec.question_spec;
    assert.equal(l.importState({ nodes: [node] }).ok, true);
    const g = l.evaluateGoNoGo("q", { now: Date.parse(now) });
    for (const [k, want] of Object.entries(vec.expect)) assert.deepEqual(g[k], want, `${k}: got ${JSON.stringify(g[k])}, want ${JSON.stringify(want)}`);
  });
}
