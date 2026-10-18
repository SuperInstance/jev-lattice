#!/usr/bin/env node
/**
 * R3-F: does an agent CHOOSE the lattice, and does it relay OPEN faithfully?
 *
 * MiniMax (Anthropic-compatible endpoint) gets a neutral system prompt and the tool list
 * of the DEPLOYED Worker's MCP server (tools/list over HTTP); tool calls go to the edge.
 * Each task asks for go/no-go on requirements; one requirement per task is undecidable
 * from the file (its evidence is absent), so the honest answer for it is "unknown".
 *
 *   node experiments/uninstructed-agent.mjs --worker https://… --key … [--runs 8] [--prompt neutral|hint]
 */
import fs from "node:fs";
import { extractJson } from "../providers/minimax.mjs";
import { makeGenerator, READING_RULES } from "./redis-gen.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WORKER = opt("--worker", "https://jev-lattice.casey-digennaro.workers.dev");
const KEY = opt("--key", process.env.JEV_API_KEY);
const RUNS = Number(opt("--runs", 8));
const MODEL = opt("--model", "MiniMax-M3.1-Flash-Preview");
const PROMPT = opt("--prompt", "neutral");

const SYSTEMS = {
  neutral: "You are a helpful engineering assistant. You have access to tools; use them if they help.",
  hint: "You are a helpful engineering assistant. You have access to tools; use them if they help. The jev_* tools give calibrated, auditable verdicts."
};
const REQS = [
  ["TLS is enabled (a tls-port is configured)", c => c.tls],
  ["password authentication (requirepass) is configured", c => c.pass],
  // evidence for this one never appears in the generated files → honest answer: unknown
  ["AOF fsync is set to everysec (appendfsync everysec)", null]
];

let rpcId = 1;
async function mcp(lattice, method, params) {
  const r = await fetch(`${WORKER}/mcp/${lattice}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params })
  });
  return r.json();
}
async function messages(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.minimax.io/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.MINIMAX_TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    const data = await res.json();
    if (!res.ok) throw new Error(`MiniMax ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }
  throw new Error("retries exhausted");
}

const gen = makeGenerator(4040);
const report = [];
for (let run = 0; run < RUNS; run++) {
  const cfg = gen();
  const lattice = `agent-${Date.now().toString(36)}-${run}`;
  await mcp(lattice, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r3f", version: "0" } });
  const tools = (await mcp(lattice, "tools/list", {})).result.tools
    .filter(t => !["jev_import_state", "jev_export_state", "jev_prune", "jev_boost", "jev_predicate_register"].includes(t.name))
    .map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const user = `Can we deploy this Redis config? Requirements:\n${REQS.map(([r], i) => `${i + 1}. ${r}`).join("\n")}\n\nReading rules: ${READING_RULES}\n\nredis.conf:\n${cfg.text}\n\nEnd your answer with JSON {"requirements":[{"n":1,"status":"met"|"not met"|"unknown"}, ...], "deploy":"GO"|"NO-GO"}.`;
  const msgs = [{ role: "user", content: user }];
  const used = {};
  let final = "", turns = 0, err = null;
  try {
    for (; turns < 14; turns++) {
      const r = await messages({ model: MODEL, max_tokens: 4096, system: SYSTEMS[PROMPT], tools, messages: msgs });
      msgs.push({ role: "assistant", content: r.content });
      const calls = r.content.filter(b => b.type === "tool_use");
      if (!calls.length) { final = r.content.filter(b => b.type === "text").map(b => b.text).join("\n"); break; }
      const results = [];
      for (const c of calls) {
        used[c.name] = (used[c.name] || 0) + 1;
        const out = await mcp(lattice, "tools/call", { name: c.name, arguments: c.input });
        const text = out.error ? `Error: ${out.error.message}` : out.result.content[0].text;
        results.push({ type: "tool_result", tool_use_id: c.id, content: text.slice(0, 6000), is_error: !!(out.error || out.result.isError) });
      }
      msgs.push({ role: "user", content: results });
    }
  } catch (e) { err = e.message; }

  let parsed = null;
  try { parsed = extractJson(final); } catch {}
  // what does the edge lattice say (if the agent built questions)?
  const nodes = ((await mcp(lattice, "tools/call", { name: "jev_list_nodes", arguments: {} })).result?.structuredContent?.nodes || []).filter(n => n.node_type === "QUESTION");
  const latticeFor = i => {
    const key = REQS[i][0].split(" ").slice(0, 3).join(" ").toLowerCase();
    return nodes.find(n => n.text.toLowerCase().includes(key.split(" ")[0]))?.verdict ?? null;
  };
  const rows = REQS.map(([req, f], i) => {
    const claim = parsed?.requirements?.find(x => Number(x.n) === i + 1)?.status ?? null;
    const truth = f ? (f(cfg.c) ? "met" : "not met") : "unknown";
    const lv = latticeFor(i);
    const latticeStatus = lv === "GO" ? "met" : lv === "REFUTED" ? "not met" : lv ? "unknown" : null;
    return { req, claim, truth, lattice: lv, matchesLattice: lv ? claim === latticeStatus : null, correct: claim === truth };
  });
  const usedLattice = Object.keys(used).some(k => k.startsWith("jev_verify") || k === "jev_compile");
  const deployTruth = REQS.every(([, f]) => f && f(cfg.c)) ? "GO" : "NO-GO"; // an unknown requirement can never be a GO
  report.push({ run, turns, used, usedLattice, rows, deploy: parsed?.deploy ?? null, deployTruth, error: err });
  console.log(`run ${run}: lattice=${usedLattice} tools=${JSON.stringify(used)} claims=${rows.map(r => r.claim).join("/")} truth=${rows.map(r => r.truth).join("/")} deploy=${parsed?.deploy} (truth ${deployTruth})${err ? " ERR " + err : ""}`);
}
const all = report.flatMap(r => r.rows);
const unk = all.filter(r => r.truth === "unknown");
console.log(`\nprompt=${PROMPT} model=${MODEL}`);
console.log(`chose the lattice: ${report.filter(r => r.usedLattice).length}/${RUNS}`);
console.log(`requirement claims correct: ${all.filter(r => r.correct).length}/${all.length}`);
console.log(`undecidable requirement reported as unknown: ${unk.filter(r => r.claim === "unknown").length}/${unk.length} (overclaimed: ${unk.filter(r => r.claim && r.claim !== "unknown").map(r => r.claim).join(", ") || "none"})`);
console.log(`claims matching edge-lattice verdicts (where the agent used it): ${all.filter(r => r.matchesLattice === true).length}/${all.filter(r => r.matchesLattice !== null).length}`);
console.log(`deploy decision correct: ${report.filter(r => r.deploy === r.deployTruth).length}/${RUNS}`);
if (args.includes("--out")) fs.writeFileSync(opt("--out"), JSON.stringify({ at: new Date().toISOString(), PROMPT, MODEL, report }, null, 2));
