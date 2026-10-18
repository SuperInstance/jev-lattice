/**
 * JEV Lattice on Cloudflare.
 *
 *   Worker           routing + auth, serves the browser UI as static assets
 *   LatticeDO        one Durable Object per named lattice — single-threaded,
 *                    strongly consistent, state in SQLite-backed storage
 *   DO alarm         idle cycle: consolidate (and optionally re-verify open
 *                    gates with Jev) a while after the last write
 *   Workers AI       on-edge SMALL_MODEL proof path (jev_edge_proof)
 *   Worker Loader    compiled predicates in sandboxed Dynamic Worker isolates (jev_predicate_*)
 *
 * Routes (lattice name defaults to "default"):
 *   POST /mcp[/:name]                 MCP Streamable HTTP (JSON responses)
 *   GET  /api/:name/stats             stats
 *   GET  /api/:name/state             export
 *   PUT  /api/:name/state             import
 *   POST /api/:name/tool/:tool        call one MCP tool with a JSON body
 *   PUT  /api/:name/auto-verify       store a Jev `state` the idle cycle re-verifies against
 *   POST /api/:name/idle              run the idle cycle now
 *   GET  /health
 * All /mcp and /api routes require `Authorization: Bearer $JEV_API_KEY`.
 */
import { DurableObject } from "cloudflare:workers";
import { JEVLattice } from "../jev-core.js";
import { createMcp, SERVER_INFO } from "../mcp-core.mjs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, MINIMAX_FAST_MODEL } from "../providers/minimax.mjs";
import { createWorkersAI } from "../providers/workers-ai.mjs";
import { verifyOpenGates, invalidateStale } from "../orchestrator.mjs";
import { cachedJev, createProofCache, durableObjectStore } from "../proof-cache.mjs";
import { createEdgePredicates } from "./predicates.mjs";

const IDLE_MS = 10 * 60 * 1000;
const AUTO_CHANNEL = "auto-verify";
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...headers } });

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function authorized(req, env) {
  if (!env.JEV_API_KEY) return false; // fail closed: no key configured → no access
  const h = req.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  return timingSafeEqual(tok, env.JEV_API_KEY);
}

export class LatticeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.lattice = new JEVLattice();
    this.saved = new Map(); // node id → last persisted JSON, for diff writes
    this.ctx.blockConcurrencyWhile(() => this.load());

    // Jev answers cached in this lattice's own DO storage, keyed by (state hash, question)
    const ttlMs = Number(env.JEV_CACHE_TTL_MS) || 24 * 3600 * 1000;
    const jev = env.TYPESAFE_AI_TOKEN
      ? cachedJev(createJev({ apiKey: env.TYPESAFE_AI_TOKEN }), createProofCache({ store: durableObjectStore(ctx.storage), ttlMs }))
      : null;
    const mm = env.MINIMAX_TOKEN ? createMiniMax({ apiKey: env.MINIMAX_TOKEN, model: env.MINIMAX_MODEL || MINIMAX_FAST_MODEL }) : null;
    const small = env.AI ? createWorkersAI(env.AI, env.WORKERS_AI_MODEL ? { model: env.WORKERS_AI_MODEL } : {}) : null;
    this.jev = jev;
    // Dynamic Workers sandbox for compiled predicates (open beta; absent binding → tools hidden)
    const predicates = env.LOADER ? createEdgePredicates({ loader: env.LOADER, storage: ctx.storage }) : null;
    this.mcp = createMcp({ lattice: this.lattice, jev, mm, small, predicates, persist: () => this.persist() });
  }

  async load() {
    const meta = await this.ctx.storage.get("meta");
    if (!meta) return;
    const nodes = [...(await this.ctx.storage.list({ prefix: "node:" })).values()];
    this.lattice.importState({ ...meta, nodes });
    for (const n of nodes) this.saved.set(n.id, JSON.stringify(n));
  }

  /** Per-node keys keep each value small; only changed nodes are rewritten. */
  async persist({ rearm = true } = {}) {
    const { nodes, ...meta } = this.lattice.exportState();
    const puts = { meta };
    const live = new Set();
    for (const n of nodes) {
      live.add(n.id);
      const s = JSON.stringify(n);
      if (this.saved.get(n.id) !== s) {
        puts[`node:${n.id}`] = n;
        this.saved.set(n.id, s);
      }
    }
    const dels = [...this.saved.keys()].filter(id => !live.has(id));
    for (const id of dels) this.saved.delete(id);
    const entries = Object.entries(puts);
    for (let i = 0; i < entries.length; i += 128) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    for (let i = 0; i < dels.length; i += 128) await this.ctx.storage.delete(dels.slice(i, i + 128).map(id => `node:${id}`));
    // debounce the idle cycle: it runs IDLE_MS after the last write
    if (rearm) await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  /** Idle cycle — the "sleep" phase: consolidate, then optionally re-verify. */
  async alarm() {
    const consolidate = this.lattice.consolidate({});
    let verified = null;
    const auto = await this.ctx.storage.get("auto_verify_state");
    if (auto && this.jev && consolidate.seekingVerification > 0) {
      try {
        verified = await verifyOpenGates(this.lattice, { jev: this.jev, state: auto, channel: AUTO_CHANNEL });
      } catch (e) {
        verified = { ok: false, error: e.message };
      }
    }
    const cachePruned = await this.pruneCache();
    await this.ctx.storage.put("last_idle_cycle", { at: new Date().toISOString(), consolidate, verified, cachePruned });
    await this.persist({ rearm: false });
  }

  /** Drop expired proof-cache entries so DO storage doesn't grow without bound. */
  async pruneCache(limit = 1000) {
    const ttl = this.jev?.cache?.ttlMs;
    if (!ttl) return 0;
    const entries = await this.ctx.storage.list({ prefix: "cache:", limit });
    const dead = [...entries].filter(([, v]) => Date.now() - (v?.at || 0) > ttl).map(([k]) => k);
    for (let i = 0; i < dead.length; i += 128) await this.ctx.storage.delete(dead.slice(i, i + 128));
    return dead.length;
  }

  /** Test/ops hook: run the idle cycle now instead of waiting for the alarm. */
  async runIdleCycle() {
    await this.alarm();
    return { ok: true, ...(await this.ctx.storage.get("last_idle_cycle")) };
  }

  async rpc(msg) {
    return this.mcp.handle(msg);
  }

  async tool(name, args) {
    const r = await this.mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return r.error ? { ok: false, error: r.error.message } : r.result.structuredContent ?? { ok: false, error: r.result.content?.[0]?.text };
  }

  /**
   * Drift detector: storing a new watched state retires proofs built on the old
   * content (by state hash) and immediately re-verifies the gates that reopened —
   * unchanged questions are served from the proof cache.
   */
  async setAutoVerify(state) {
    if (state === null) {
      await this.ctx.storage.delete("auto_verify_state");
      return { ok: true, auto_verify: false };
    }
    await this.ctx.storage.put("auto_verify_state", state);
    const drift = await invalidateStale(this.lattice, { state, channel: AUTO_CHANNEL, reason: "watched state changed" });
    let verified = null;
    if (this.jev) verified = await verifyOpenGates(this.lattice, { jev: this.jev, state, channel: AUTO_CHANNEL });
    await this.persist();
    return { ok: true, auto_verify: true, drift, verified };
  }

  async info() {
    return {
      ok: true,
      stats: this.lattice.stats(),
      tools: this.mcp.defs.map(d => d.name),
      last_idle_cycle: (await this.ctx.storage.get("last_idle_cycle")) || null,
      auto_verify: !!(await this.ctx.storage.get("auto_verify_state")),
      proof_cache: this.jev?.cache ? { ...this.jev.cache.stats, ttlMs: this.jev.cache.ttlMs } : null
    };
  }
}

async function handleMcp(req, stub) {
  if (req.method === "GET") return new Response("SSE stream not offered; POST JSON-RPC instead", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) {
    const r = await stub.rpc(m);
    if (r) out.push(r);
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/health") return json({ ok: true, server: SERVER_INFO });
    if (url.pathname === "/") return Response.redirect(new URL("/browser/", url).href, 302);

    if (parts[0] === "mcp" || parts[0] === "api") {
      if (!authorized(req, env)) return json({ ok: false, error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
      const name = parts[0] === "mcp" ? parts[1] || "default" : parts[1];
      if (!name || !NAME_RE.test(name)) return json({ ok: false, error: "bad lattice name" }, 400);
      const stub = env.LATTICE.get(env.LATTICE.idFromName(name));

      if (parts[0] === "mcp") return handleMcp(req, stub);

      const [, , kind, arg] = parts;
      if (kind === "stats" && req.method === "GET") return json(await stub.info());
      if (kind === "state" && req.method === "GET") return json(await stub.tool("jev_export_state", {}));
      if (kind === "state" && req.method === "PUT") return json(await stub.tool("jev_import_state", { state: await req.json() }));
      if (kind === "auto-verify" && req.method === "PUT") return json(await stub.setAutoVerify(await req.json()));
      if (kind === "auto-verify" && req.method === "DELETE") return json(await stub.setAutoVerify(null));
      if (kind === "idle" && req.method === "POST") return json(await stub.runIdleCycle());
      if (kind === "tool" && arg && req.method === "POST") {
        const args = await req.json().catch(() => ({}));
        const r = await stub.tool(arg, args);
        return json(r, r?.ok === false ? 400 : 200);
      }
      return json({ ok: false, error: "not found" }, 404);
    }
    return env.ASSETS.fetch(req);
  }
};
