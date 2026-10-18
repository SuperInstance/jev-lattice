// The README's examples must run. If this fails, the docs are wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = f => execFileSync(process.execPath, [path.join(root, f)], { env: { ...process.env, TYPESAFE_AI_TOKEN: "" }, encoding: "utf8" });

test("examples/quickstart.mjs prints the documented verdicts", () => {
  const out = run("examples/quickstart.mjs").trim().split("\n");
  assert.equal(out[0], "OPEN");
  assert.equal(out[1], "GO - 2/2 independent proofs satisfied");
  assert.equal(out[2], "OPEN");
  assert.equal(out[3], "1 question(s) restored");
});

test("examples/verify-files.mjs: unrelated change keeps the proof, related change retires it", () => {
  const out = run("examples/verify-files.mjs");
  assert.match(out, /before: GO/);
  assert.match(out, /app\.env changed → invalidated: 0/);
  assert.match(out, /redis\.conf changed → invalidated: 1/);
  assert.match(out, /after: REFUTED/);
});
