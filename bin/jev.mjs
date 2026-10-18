#!/usr/bin/env node
/**
 * jev — command-line entry point.
 *
 *   jev gate  [--config jev.gates.json] [--root .] [--state .jev/state.json]
 *             [--format text|json|markdown] [--offline]
 *   jev check-config [--config jev.gates.json]
 *   jev mcp                      start the stdio MCP server
 *   jev version
 *
 * Exit codes (gate): 0 all GO · 1 at least one gate not GO (fails closed) · 2 usage/config error.
 * Env: TYPESAFE_AI_TOKEN (required unless --offline), JEV_CACHE_TTL_MS.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, def) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : def; };
const has = name => rest.includes(`--${name}`);
const die = (msg, code = 2) => { process.stderr.write(`jev: ${msg}\n`); process.exit(code); };

if (!cmd || cmd === "help" || cmd === "--help") {
  process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, "") + "\n");
  process.exit(0);
}
if (cmd === "version") {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (cmd === "mcp") {
  await import(path.join(here, "..", "mcp-server.mjs"));
} else if (cmd === "gate" || cmd === "check-config") {
  const { loadConfig, runGate, formatResult } = await import(path.join(here, "..", "gate.mjs"));
  const configPath = flag("config", "jev.gates.json");
  if (!fs.existsSync(configPath)) die(`config not found: ${configPath}`);
  let loaded;
  try { loaded = loadConfig(configPath); } catch (e) { die(`config is not valid JSON: ${e.message}`); }
  if (loaded.errors.length) die(`invalid config:\n  ${loaded.errors.join("\n  ")}`);
  if (cmd === "check-config") { process.stdout.write(`ok: ${loaded.cfg.gates.length} gate(s)\n`); process.exit(0); }

  let jev = null;
  if (!has("offline")) {
    if (!process.env.TYPESAFE_AI_TOKEN) die("TYPESAFE_AI_TOKEN is not set (use --offline to evaluate existing proofs only)");
    const { createJev } = await import(path.join(here, "..", "providers", "jev.mjs"));
    const { cachedJev, createProofCache } = await import(path.join(here, "..", "proof-cache.mjs"));
    jev = cachedJev(createJev(), createProofCache({ ttlMs: Number(process.env.JEV_CACHE_TTL_MS) || 24 * 3600e3 }));
  }
  const run = await runGate({ cfg: loaded.cfg, root: flag("root", "."), statePath: flag("state", ".jev/state.json"), jev });
  process.stdout.write(formatResult(run, flag("format", "text")) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatResult(run, "markdown") + "\n");
  process.exit(run.pass ? 0 : 1);
} else {
  die(`unknown command "${cmd}" (try: jev help)`);
}
