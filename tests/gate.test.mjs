/**
 * Config-driven gating (gate.mjs) and the jev CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, runGate, formatResult } from "../gate.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeJev = () => {
  const seen = { questions: 0 };
  return {
    seen, model: "fake",
    async nouls(state, items) {
      seen.questions += items.length;
      const text = JSON.stringify(state);
      const out = { _model: "fake" };
      for (const it of items) out[it.key] = { p: /TLS/.test(it.instructions) ? (text.includes("tls-port") ? 0.98 : 0.02) : (text.includes("DEBUG=false") ? 0.97 : 0.03) };
      return out;
    }
  };
};
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-gate-"));
  fs.mkdirSync(path.join(dir, "deploy"));
  fs.writeFileSync(path.join(dir, "deploy/redis.conf"), "port 0\ntls-port 6380");
  fs.writeFileSync(path.join(dir, "deploy/app.env"), "DEBUG=false");
  const cfg = { threshold: 0.9, gates: [
    { id: "redis-tls", question: "Is TLS enabled (a tls-port is configured)?", reads: ["deploy/redis.conf"] },
    { id: "no-debug", question: "Is DEBUG disabled?", reads: ["deploy/app.env"] }
  ] };
  fs.writeFileSync(path.join(dir, "jev.gates.json"), JSON.stringify(cfg));
  return { dir, cfg, state: path.join(dir, ".jev/state.json") };
}

test("loadConfig reports every problem at once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-cfg-"));
  fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify({ threshold: 2, gates: [{ id: "a" }, { id: "a", question: "q", reads: [] }] }));
  const { errors } = loadConfig(path.join(dir, "c.json"));
  assert.ok(errors.some(e => e.includes("gates[0].question")));
  assert.ok(errors.some(e => e.includes('duplicate "a"')));
  assert.ok(errors.some(e => e.includes("gates[1].reads")));
  assert.ok(errors.some(e => e.includes("threshold")));
});

test("runGate: GO, then only changed files are re-asked, and state persists", async () => {
  const w = workspace();
  const jev = fakeJev();
  const r1 = await runGate({ cfg: w.cfg, root: w.dir, statePath: w.state, jev });
  assert.equal(r1.pass, true);
  assert.equal(jev.seen.questions, 2);
  const r2 = await runGate({ cfg: w.cfg, root: w.dir, statePath: w.state, jev });
  assert.equal(r2.pass, true);
  assert.equal(jev.seen.questions, 2, "nothing changed → no verifier call");
  fs.writeFileSync(path.join(w.dir, "deploy/app.env"), "DEBUG=true");
  const r3 = await runGate({ cfg: w.cfg, root: w.dir, statePath: w.state, jev });
  assert.equal(jev.seen.questions, 3, "only the gate reading app.env is re-asked");
  assert.deepEqual(r3.drift, ["deploy/app.env"]);
  assert.equal(r3.pass, false);
  assert.equal(r3.results.find(r => r.id === "no-debug").verdict, "REFUTED");
  assert.match(formatResult(r3, "markdown"), /❌ not all GO/);
});

test("runGate fails closed: missing files and verifier errors are never GO", async () => {
  const w = workspace();
  fs.rmSync(path.join(w.dir, "deploy/app.env"));
  const r = await runGate({ cfg: w.cfg, root: w.dir, jev: fakeJev() });
  assert.equal(r.pass, false);
  assert.deepEqual(r.missing, ["deploy/app.env"]);
  assert.match(r.results.find(x => x.id === "no-debug").reason, /missing file/);
  const broken = { model: "x", async nouls() { throw new Error("verifier down"); } };
  const r2 = await runGate({ cfg: w.cfg, root: w.dir, jev: broken });
  assert.equal(r2.pass, false);
  assert.equal(r2.verifierError, "verifier down");
});

test("a changed question replaces its gate; removed gates leave the state", async () => {
  const w = workspace();
  await runGate({ cfg: w.cfg, root: w.dir, statePath: w.state, jev: fakeJev() });
  const cfg2 = { ...w.cfg, gates: [{ ...w.cfg.gates[0], question: "Is TLS enabled on port 6380?" }] };
  const r = await runGate({ cfg: cfg2, root: w.dir, statePath: w.state, jev: fakeJev() });
  assert.equal(r.results.length, 1);
  const st = JSON.parse(fs.readFileSync(w.state, "utf8"));
  assert.equal(st.nodes.length, 1);
  assert.equal(st.nodes[0].text, "Is TLS enabled on port 6380?");
});

test("CLI: check-config, offline gate exit codes, usage errors", () => {
  const w = workspace();
  const cli = (...a) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, "bin/jev.mjs"), ...a], { cwd: w.dir, encoding: "utf8", env: { ...process.env, TYPESAFE_AI_TOKEN: "", GITHUB_STEP_SUMMARY: "" } }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
  assert.equal(cli("check-config").code, 0);
  const offline = cli("gate", "--offline");
  assert.equal(offline.code, 1, "no proofs yet → OPEN → exit 1 (fails closed)");
  assert.match(offline.out, /FAIL/);
  assert.equal(cli("gate").code, 2, "no token and not offline → usage error");
  assert.equal(cli("gate", "--config", "nope.json").code, 2);
  assert.match(cli("version").out, /^\d+\.\d+\.\d+/);
});
