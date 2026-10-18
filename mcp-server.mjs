#!/usr/bin/env node
/**
 * JEV Lattice MCP server — stdio transport (newline-delimited JSON-RPC).
 *
 *   node mcp-server.mjs
 *
 * Env:
 *   JEV_STATE_PATH      lattice file (default ./jev-state.json)
 *   JEV_TIER            minimal | standard | high (default: auto probe)
 *   TYPESAFE_AI_TOKEN   enables jev_verify / jev_verify_open / jev_compile
 *   MINIMAX_TOKEN       enables jev_minimax_proof / jev_decompose / jev_compile
 *   JEV_NO_PROVIDERS=1  disable both providers (offline / tests)
 *   JEV_CACHE=0         disable the (state hash, question) proof cache
 *   JEV_CACHE_TTL_MS    cache entry lifetime (default 24h)
 *   JEV_PROFILE         tool profile: gatekeeper | reader (default: all tools)
 *   JEV_MODEL           pin the Jev model (e.g. jev-1.13.0); default jev-latest
 */
import { JEVLattice, SCHEMA } from "./jev-core.js";
import { createHarness } from "./harness.mjs";
import { createMcp } from "./mcp-core.mjs";
import { createJev } from "./providers/jev.mjs";
import { createMiniMax } from "./providers/minimax.mjs";
import { cachedJev, createProofCache } from "./proof-cache.mjs";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

const STATE_PATH = process.env.JEV_STATE_PATH || path.join(process.cwd(), "jev-state.json");
const log = m => process.stderr.write(`[jev-mcp] ${m}\n`);

const lattice = new JEVLattice();
const harness = createHarness();

if (fs.existsSync(STATE_PATH)) {
  try {
    const res = lattice.importState(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")));
    if (!res.ok) throw new Error(res.error);
    log(`loaded ${res.nodes} nodes from ${STATE_PATH}`);
  } catch (e) {
    log(`failed to load state (${e.message}); starting empty — original file left untouched until first write`);
  }
}

function persist() {
  // write-then-rename so a crash never leaves a truncated state file
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(lattice.exportState(), null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    log(`persist error: ${e.message}`);
  }
}

const offline = process.env.JEV_NO_PROVIDERS === "1";
const rawJev = !offline && process.env.TYPESAFE_AI_TOKEN ? createJev() : null;
const jev = rawJev && process.env.JEV_CACHE !== "0"
  ? cachedJev(rawJev, createProofCache({ ttlMs: Number(process.env.JEV_CACHE_TTL_MS) || 24 * 3600 * 1000 }))
  : rawJev;
const mm = !offline && process.env.MINIMAX_TOKEN ? createMiniMax() : null;

const mcp = createMcp({
  profile: process.env.JEV_PROFILE || null, // e.g. "gatekeeper" for agents
  lattice,
  jev,
  mm,
  capacity: () => harness.snapshot(),
  consolidateOpts: () => harness.policy().consolidateOpts || {},
  persist
});

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");

// Serialize message handling so concurrent async tools never interleave writes.
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", line => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch (e) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${e.message}` } });
    return;
  }
  chain = chain.then(async () => {
    const res = await mcp.handle(msg);
    if (res) send(res);
  }).catch(e => log(`handler error: ${e.stack || e.message}`));
});
rl.on("close", () => chain.then(() => process.exit(0)));

log(`ready schema=${SCHEMA} state=${STATE_PATH} tier=${harness.policy().tier} jev=${!!jev} minimax=${!!mm} tools=${mcp.defs.length}`);
