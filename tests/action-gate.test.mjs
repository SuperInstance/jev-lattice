/**
 * The composite action in action.yml IS the gate. These tests assert what it decides, because
 * the failure it is guarding against is a gate that decides nothing and still reports green.
 *
 * Two distinct defects live here, and fixing only one of them leaves the action worse than
 * before:
 *
 *   1. `if: steps.gate.outputs.code != '0'` -- a skipped step has no outputs, so the value is
 *      null; null coerces to 0, and 0 == '0', so `!=` is false and the fail step is skipped.
 *      A gate that never ran reports success.
 *   2. `set +e` plus a trailing `echo` means the Evaluate step exits 0 *even when a gate is
 *      REFUTED*, so `steps.gate.outcome` is `success` in every case. Swapping the condition to
 *      `outcome != 'success'` without also fixing the step's exit status turns the gate into one
 *      that never fails at all -- a strictly larger silent green.
 *
 * Both are asserted here so neither can come back on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCompositeAction, findStep } from "./helpers/composite-action.mjs";
import { evalIf, stepContext } from "./helpers/gha-expr.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTION = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
const steps = parseCompositeAction(ACTION);
const gateStep = findStep(steps, "Evaluate gates");
const failStep = findStep(steps, "Fail when gates are not GO");

/** True when the action's "Fail when gates are not GO" step would run. */
function gateFailsFor(stepState) {
  return evalIf(failStep.if, stepContext({ gate: stepState }));
}

const RAN_AND_GO = { outcome: "success", outputs: { code: "0", pass: "true" } };
const RAN_AND_REFUTED = { outcome: "failure", outputs: { code: "1", pass: "false" } };
const SKIPPED = { outcome: "skipped" };
const CANCELLED = { outcome: "cancelled" };

test("a skipped gate step FAILS the gate", () => {
  // The headline defect. A skipped step sets no outputs, so the old string comparison read
  // null as 0 and waved the run through.
  assert.equal(
    gateFailsFor(SKIPPED),
    true,
    "if the 'Evaluate gates' step is skipped, the action must fail -- it did not evaluate anything",
  );
});

test("a cancelled gate step FAILS the gate", () => {
  assert.equal(gateFailsFor(CANCELLED), true, "a cancelled gate step must not report success");
});

test("a gate step that ran and failed FAILS the gate", () => {
  assert.equal(gateFailsFor(RAN_AND_REFUTED), true);
});

test("the gate passes only when every gate is GO", () => {
  assert.equal(gateFailsFor(RAN_AND_GO), false);
});

test("the gate keys on steps.gate.outcome, not on an output string", () => {
  assert.match(
    failStep.if,
    /steps\.gate\.outcome/,
    `the gate condition must read the step's outcome; got: ${failStep.if}`,
  );
  assert.doesNotMatch(
    failStep.if,
    /steps\.gate\.outputs\./,
    `the gate condition must not compare a step output to a literal; that is the defect. got: ${failStep.if}`,
  );
});

test("the Evaluate step exits non-zero when a gate is not GO", { skip: process.platform === "win32" ? "needs bash" : false }, () => {
  // Guard the other half of the fix. If `set +e` swallows the verifier's status, the step exits
  // 0, outcome is 'success', and an outcome-based gate can never fire.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-gate-"));
  const stubDir = path.join(dir, "bin");
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, "node");
  fs.writeFileSync(stub, "#!/bin/sh\necho 'REFUTED  gate-1: TLS is enabled' >&2\nexit 1\n");
  fs.chmodSync(stub, 0o755);

  const script = gateStep.run
    .replace(/\$\{\{\s*inputs\.config\s*\}\}/g, "jev.gates.json")
    .replace(/\$\{\{\s*inputs\.root\s*\}\}/g, ".")
    .replace(/\$\{\{\s*inputs\.state-path\s*\}\}/g, ".jev/state.json")
    .replace(/\$\{\{\s*inputs\.format\s*\}\}/g, "text")
    .replace(/\$\{\{\s*inputs\.offline\s*\}\}/g, "false")
    .replace(/\$\{\{\s*github\.action_path\s*\}\}/g, dir);
  const scriptPath = path.join(dir, "step.sh");
  fs.writeFileSync(scriptPath, script);

  const outputPath = path.join(dir, "github_output");
  fs.writeFileSync(outputPath, "");
  // GitHub runs `run:` blocks as `bash -e <file>`.
  const res = spawnSync("bash", ["-e", scriptPath], {
    env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: outputPath },
    encoding: "utf8",
  });

  const written = fs.readFileSync(outputPath, "utf8");
  assert.match(written, /^code=1$/m, "the step should still publish code=1");
  assert.notEqual(
    res.status,
    0,
    `the Evaluate step must exit non-zero when a gate is REFUTED, or steps.gate.outcome is ` +
      `'success' and an outcome-based gate can never fire. (status=${res.status})`,
  );
});

test("the Evaluate step still exits zero when every gate is GO", { skip: process.platform === "win32" ? "needs bash" : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-gate-ok-"));
  const stubDir = path.join(dir, "bin");
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, "node");
  fs.writeFileSync(stub, "#!/bin/sh\necho 'GO  gate-1: TLS is enabled'\nexit 0\n");
  fs.chmodSync(stub, 0o755);

  const script = gateStep.run
    .replace(/\$\{\{\s*inputs\.config\s*\}\}/g, "jev.gates.json")
    .replace(/\$\{\{\s*inputs\.root\s*\}\}/g, ".")
    .replace(/\$\{\{\s*inputs\.state-path\s*\}\}/g, ".jev/state.json")
    .replace(/\$\{\{\s*inputs\.format\s*\}\}/g, "text")
    .replace(/\$\{\{\s*inputs\.offline\s*\}\}/g, "false")
    .replace(/\$\{\{\s*github\.action_path\s*\}\}/g, dir);
  const scriptPath = path.join(dir, "step.sh");
  fs.writeFileSync(scriptPath, script);
  const outputPath = path.join(dir, "github_output");
  fs.writeFileSync(outputPath, "");

  const res = spawnSync("bash", ["-e", scriptPath], {
    env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: outputPath },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, "an all-GO run must not fail");
  assert.match(fs.readFileSync(outputPath, "utf8"), /^pass=true$/m);
});
