#!/usr/bin/env node
/**
 * Browser UI e2e (Playwright). Serves the repo root statically, or hits a URL.
 *   node tests/e2e/browser.e2e.mjs [https://deployed.example]
 * Needs `playwright` resolvable (global install is fine: NODE_PATH=$(npm root -g)).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let server, base = process.argv[2];
if (!base) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const browser = await chromium.launch(fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => m.type() === "error" && errors.push(m.text()));
let failed = 0;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };

try {
  await page.goto(`${base}/browser/`);
  await page.waitForFunction(() => window.JEV?.version);
  check(await page.evaluate(() => window.JEV.version) === "0.3.0", "core loaded, window.JEV ready");
  await page.click("#btn-seed");
  const n = await page.evaluate(() => window.JEV.lattice.listNodes().length);
  check(n > 0, `seed demo → ${n} nodes`);

  // Build a COORDINATED question through the UI and close it with two cheap proofs
  await page.evaluate(() => document.querySelector('[data-tab="experience"]')?.click());
  await page.fill("#exp-text", "Is the e2e cache production ready?");
  await page.check("#exp-as-question");
  await page.selectOption("#exp-mode", "COORDINATED");
  await page.fill("#exp-required", "2");
  await page.fill("#exp-threshold", "0.9");
  await page.click("#btn-ingest");
  const id = await page.evaluate(() => window.JEV.lattice.listNodes().find(n => n.text.startsWith("Is the e2e"))?.id);
  check(!!id, "question ingested via UI");
  const gate = () => page.evaluate(i => window.JEV.call("evaluateGoNoGo", { id: i }), id);
  check((await gate()).verdict === "OPEN", "gate OPEN");
  await page.evaluate(i => window.JEV.call("addProof", { id: i, proof: { source_type: "SENSOR", confidence: 0.95 } }), id);
  await page.evaluate(i => window.JEV.call("addProof", { id: i, proof: { source_type: "DETERMINISTIC_PARSER", confidence: 0.99 } }), id);
  check((await gate()).verdict === "GO", "two independent proofs → GO");
  if (process.env.JEV_API_KEY && process.argv[2]) {
    // edge round-trip: push → Jev fan-out at the edge → pull
    await page.evaluate(() => document.querySelector('[data-tab="tools"]')?.click());
    await page.fill("#edge-name", `e2e-${Date.now().toString(36)}`);
    await page.fill("#edge-key", process.env.JEV_API_KEY);
    const q2 = await page.evaluate(() => window.JEV.call("ingest", { text: "Does the text say the sky is green?", question_spec: { confidence_threshold: 0.9 } }).node.id);
    await page.click("#btn-edge-verify");
    await page.waitForFunction(i => (window.JEV.lattice.getNode(i)?.active_proofs || []).some(p => p.source_type === "JEV_NOUL"), q2, { timeout: 30000 });
    const v = await page.evaluate(i => window.JEV.call("evaluateGoNoGo", { id: i }).verdict, q2);
    check(v === "REFUTED" || v === "OPEN", `edge Jev verify round-trip → ${v}`);
  }
  await page.click("#btn-idle");
  await page.screenshot({ path: path.join(root, "docs", "screenshot.png") });
  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} finally {
  await browser.close();
  server?.close();
}
console.log(failed ? `${failed} FAILED` : "browser e2e passed");
process.exit(failed ? 1 : 0);
