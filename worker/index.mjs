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
 * Routes (lattice name defaults to "default"); [scope] each route needs:
 *   POST /mcp[/:name]                 MCP Streamable HTTP (JSON responses)   [per tool]
 *   GET  /api/:name/stats             stats                                  [read]
 *   GET  /api/:name/state             export                                 [read]
 *   PUT  /api/:name/state             import                                 [admin]
 *   POST /api/:name/tool/:tool        call one MCP tool with a JSON body     [per tool]
 *   GET  /api/:name/audit             verdict-change log (?limit, ?node)     [read]
 *   GET  /api/:name/settings          providers, profile, quotas             [read]
 *   PUT  /api/:name/settings                                                 [admin]
 *   PUT  /api/:name/auto-verify       store a Jev `state` the idle cycle re-verifies against [admin]
 *   POST /api/:name/idle              run the idle cycle now                 [admin]
 *   POST /admin/keys | GET /admin/keys | DELETE /admin/keys/:id              [root only]
 *   GET  /admin/events                key create / revoke history            [root only]
 *   GET  /admin/lattices              every lattice ever written             [root only]
 *   POST /admin/backup                back up every lattice to R2 now        [root only]
 *   GET  /admin/backups/:name         list a lattice's backups               [root only]
 *   POST /admin/restore/:name         {key} restore a backup into the lattice [root only]
 * Cron (wrangler triggers): daily backup of every lattice to R2 (BACKUPS), 30-day retention.
 *   GET  /health
 * /mcp, /api and /admin require `Authorization: Bearer <key>`: the root JEV_API_KEY or a
 * tenant key issued by /admin/keys (worker/control.mjs).
 */
import { DurableObject } from "cloudflare:workers";
import { JEVLattice } from "../jev-core.js";
import { createMcp, SERVER_INFO, isMutating } from "../mcp-core.mjs";
import { registerLattice, listLattices, authenticate, limitFailedAuth, canAccessLattice, hasScope, toolScope, rateLimit, createKey, listKeys, revokeKey, listKeyEvents, PROVIDERS, defaultSettings, mergeSettings } from "./control.mjs";
import { createJev } from "../providers/jev.mjs";
import { createMiniMax, MINIMAX_FAST_MODEL } from "../providers/minimax.mjs";
import { createWorkersAI } from "../providers/workers-ai.mjs";
import { verifyOpenGates, invalidateStale } from "../orchestrator.mjs";
import { cachedJev, createProofCache, durableObjectStore } from "../proof-cache.mjs";
import { createEdgePredicates } from "./predicates.mjs";
import { createSenseSuite } from "../senses.mjs";

const IDLE_MS = 10 * 60 * 1000;
const AUTO_CHANNEL = "auto-verify";
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...headers } });

const ROOT = { id: "root", tenant: "root", scopes: ["admin"], lattices: ["*"], profile: null, root: true };
const NODE_TOOLS = new Set(["jev_ingest", "jev_decompose"]);
const PROOF_TOOLS = new Set(["jev_add_proof", "jev_verify", "jev_minimax_proof", "jev_edge_proof", "jev_predicate_proof",
  "jev_verify_open", "jev_verify_files", "jev_compile", "jev_rollup", "jev_sense_probe"]);
const AUDIT_KEEP = 10000;

export class LatticeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.lattice = new JEVLattice();
    this.saved = new Map(); // node id → last persisted JSON, for diff writes
    this.settings = defaultSettings(env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.settings = { ...this.settings, ...((await this.ctx.storage.get("settings")) || {}) };
      await this.load();
      this.buildMcp();
    });
  }

  /** Providers are per-lattice settings (default: TypeSafe only) — a tenant opts in to the rest. */
  buildMcp() {
    const { env, ctx } = this;
    const on = p => this.settings.providers.includes(p);
    // Jev answers cached in this lattice's own DO storage, keyed by (model, state hash, question)
    const ttlMs = Number(env.JEV_CACHE_TTL_MS) || 24 * 3600 * 1000;
    const jev = on("typesafe") && env.TYPESAFE_AI_TOKEN
      ? cachedJev(createJev({ apiKey: env.TYPESAFE_AI_TOKEN, ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}) }),
          createProofCache({ store: durableObjectStore(ctx.storage), ttlMs }))
      : null;
    const mm = on("minimax") && env.MINIMAX_TOKEN ? createMiniMax({ apiKey: env.MINIMAX_TOKEN, model: env.MINIMAX_MODEL || MINIMAX_FAST_MODEL }) : null;
    const small = on("workers-ai") && env.AI ? createWorkersAI(env.AI, env.WORKERS_AI_MODEL ? { model: env.WORKERS_AI_MODEL } : {}) : null;
    this.jev = jev;
    // Dynamic Workers sandbox for compiled predicates (open beta; absent binding → tools hidden)
    const predicates = on("predicates") && env.LOADER ? createEdgePredicates({ loader: env.LOADER, storage: ctx.storage }) : null;
    // cross-sense teaching: label bank + paraphrase cache live in this lattice's DO storage
    const senses = jev ? createSenseSuite({ jev, mm, small, predicates, store: durableObjectStore(ctx.storage, "sense:"), rules: env.JEV_READING_RULES || null }) : null;
    const extraTools = [
      {
        def: { name: "jev_audit", description: "Verdict-change log for this lattice: who called which mutating tool, and which gates it moved.",
          inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 }, node: { type: "string" } } } },
        handler: args => this.auditLog(args)
      },
      {
        def: { name: "jev_settings", description: "This lattice's settings: enabled providers, default tool profile, quotas.",
          inputSchema: { type: "object", properties: {} } },
        handler: () => ({ ok: true, settings: this.settings, model: jev?.model ?? null })
      }
    ];
    this.mcp = createMcp({ lattice: this.lattice, jev, mm, small, predicates, senses, extraTools, persist: () => this.persist() });
  }

  /** The Worker passes the lattice name with every call (a DO cannot recover it from its id). */
  async remember(name) {
    if (!name || this.name === name) return;
    this.name = name;
    if ((await this.ctx.storage.get("name")) !== name) await this.ctx.storage.put("name", name);
  }

  /** Full snapshot for backup: state, settings, audit, watched state. */
  async backup() {
    this.ensureAudit();
    return {
      schema: "jev-lattice-backup/1",
      lattice: this.name ?? (await this.ctx.storage.get("name")) ?? null,
      at: new Date().toISOString(),
      state: this.lattice.exportState(),
      settings: this.settings,
      auto_verify_state: (await this.ctx.storage.get("auto_verify_state")) ?? null,
      audit: this.ctx.storage.sql.exec("SELECT * FROM audit ORDER BY seq").toArray()
    };
  }

  /** Restore a backup: replaces state and settings; the audit log keeps its history and records the restore. */
  async restore(b, principal = ROOT) {
    if (b?.schema !== "jev-lattice-backup/1" || !b.state) return { ok: false, error: "not a jev-lattice backup" };
    return this.audited(principal.id, "restore", async () => {
      const r = this.lattice.importState(b.state);
      if (!r.ok) return r;
      if (b.settings) { this.settings = { ...defaultSettings(this.env), ...b.settings }; await this.ctx.storage.put("settings", this.settings); this.buildMcp(); }
      if (b.auto_verify_state) await this.ctx.storage.put("auto_verify_state", b.auto_verify_state);
      await this.persist();
      return { ok: true, restored_from: b.at, nodes: r.nodes };
    });
  }

  ctxFor(principal = ROOT) {
    return {
      allow: n => hasScope(principal, toolScope(n)) || `${n} needs scope "${toolScope(n)}"`,
      guard: (n, args) => this.quota(n, args),
      profile: principal.profile ?? this.settings.profile
    };
  }

  quota(name, args = {}) {
    const s = this.settings;
    const nodes = this.lattice.nodes.size;
    if (NODE_TOOLS.has(name) && nodes >= s.max_nodes) return `quota: lattice has ${nodes} nodes (max_nodes ${s.max_nodes}); prune first`;
    if (name === "jev_import_state" && (args.state?.nodes?.length || 0) > s.max_nodes) return `quota: import has ${args.state.nodes.length} nodes (max_nodes ${s.max_nodes})`;
    if (PROOF_TOOLS.has(name)) {
      let total = 0;
      for (const n of this.lattice.nodes.values()) total += n.active_proofs?.length || 0;
      if (total >= s.max_proofs) return `quota: lattice holds ${total} proofs (max_proofs ${s.max_proofs}); prune or re-import a compacted state`;
      const n = args.id ? this.lattice.getNode(args.id) : null;
      if (n && (n.active_proofs?.length || 0) >= s.max_proofs_per_node) return `quota: node ${args.id} has ${n.active_proofs.length} proofs (max_proofs_per_node ${s.max_proofs_per_node})`;
    }
    return null;
  }

  /** question id → { verdict, proofs } */
  snapshot() {
    const m = new Map();
    for (const n of this.lattice.nodes.values()) {
      if (n.node_type !== "QUESTION") continue;
      const g = this.lattice.evaluateGoNoGo(n.id);
      m.set(n.id, { verdict: g.verdict, margin: g.margin, proofs: n.active_proofs?.length || 0 });
    }
    return m;
  }

  /** Run a mutation and record which verdicts it moved, with the proofs that moved them. */
  async audited(actor, tool, fn, okOf = r => r?.ok !== false) {
    // every verdict change goes through here, so the last "after" is the next "before"
    // (halves the cost per call on large lattices). Proof expiry by age can move a verdict
    // between calls; it is then attributed to the next call, which is noted in the docs.
    const before = this.lastSnapshot ?? this.snapshot();
    const r = await fn();
    const after = this.snapshot();
    this.lastSnapshot = after;
    const changes = [];
    let newProofs = 0;
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(id), a = after.get(id);
      const added = Math.max(0, (a?.proofs || 0) - (b?.proofs || 0));
      newProofs += added;
      if (b?.verdict === a?.verdict) continue;
      const node = this.lattice.getNode(id);
      changes.push({
        id, text: node?.text?.slice(0, 120) ?? null, from: b?.verdict ?? null, to: a?.verdict ?? null, margin: a?.margin ?? null,
        proofs: added && node ? node.active_proofs.slice(-added).map(p => ({ proof_id: p.proof_id, source_type: p.source_type, confidence: p.confidence })) : []
      });
    }
    const sql = this.ctx.storage.sql;
    this.ensureAudit();
    sql.exec("INSERT INTO audit (at, actor, tool, ok, changes, new_proofs) VALUES (?, ?, ?, ?, ?, ?)",
      new Date().toISOString(), actor, tool, okOf(r) ? 1 : 0, JSON.stringify(changes), newProofs);
    sql.exec("DELETE FROM audit WHERE seq <= (SELECT MAX(seq) FROM audit) - ?", AUDIT_KEEP);
    return r;
  }

  /** Created on first write, so reading a lattice that was never used leaves no storage behind. */
  ensureAudit() {
    if (this.auditReady) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
      ok INTEGER NOT NULL, changes TEXT NOT NULL, new_proofs INTEGER NOT NULL)`);
    this.auditReady = true;
  }

  auditLog({ limit = 50, node = null } = {}) {
    limit = Math.min(Math.max(1, Number(limit) || 50), 500);
    const sql = this.ctx.storage.sql;
    if (!this.auditReady && !sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit'").toArray().length) return { ok: true, entries: [] };
    this.auditReady = true;
    // exact match on a change's id (json_each), not LIKE: node ids can contain LIKE wildcards
    const rows = node
      ? sql.exec("SELECT * FROM audit WHERE EXISTS (SELECT 1 FROM json_each(audit.changes) WHERE json_extract(value, '$.id') = ?) ORDER BY seq DESC LIMIT ?", String(node), limit).toArray()
      : sql.exec("SELECT * FROM audit ORDER BY seq DESC LIMIT ?", limit).toArray();
    return { ok: true, entries: rows.map(r => ({ ...r, ok: !!r.ok, changes: JSON.parse(r.changes) })) };
  }

  async getSettings() {
    return { ok: true, settings: this.settings, providers_available: PROVIDERS, model: this.jev?.model ?? null };
  }

  async putSettings(patch, principal = ROOT) {
    await this.remember(principal.lattice);
    const m = mergeSettings(this.settings, patch);
    if (!m.ok) return m;
    await this.audited(principal.id, "settings", async () => {
      this.settings = m.settings;
      await this.ctx.storage.put("settings", this.settings);
      this.buildMcp();
      return { ok: true };
    });
    return this.getSettings();
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
    // keep the lattice registry (backup work list) current, at most once a minute
    if (this.name && (!this.registeredAt || Date.now() - this.registeredAt > 60e3)) {
      this.registeredAt = Date.now();
      await registerLattice(this.env, this.name).catch(e => console.error(JSON.stringify({ event: "registry_error", lattice: this.name, error: e.message })));
    }
  }

  /** Idle cycle — the "sleep" phase: consolidate, then optionally re-verify. */
  async alarm() {
    const consolidate = this.lattice.consolidate({});
    let verified = null;
    const auto = await this.ctx.storage.get("auto_verify_state");
    if (auto && this.jev && consolidate.seekingVerification > 0) {
      verified = await this.audited("system:idle", "verify_open", async () => {
        try {
          return await verifyOpenGates(this.lattice, { jev: this.jev, state: auto, channel: AUTO_CHANNEL });
        } catch (e) {
          return { ok: false, error: e.message };
        }
      });
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
  async runIdleCycle(principal = ROOT) {
    await this.remember(principal.lattice);
    await this.audited(principal.id, "idle_cycle", () => this.alarm());
    return { ok: true, ...(await this.ctx.storage.get("last_idle_cycle")) };
  }

  async rpc(msg, principal = ROOT) {
    await this.remember(principal.lattice);
    const ctx = this.ctxFor(principal);
    const name = msg?.method === "tools/call" ? msg.params?.name : null;
    if (name && isMutating(name) && ctx.allow(name) === true) {
      return this.audited(principal.id, name, () => this.mcp.handle(msg, ctx), r => !r?.error && !r?.result?.isError);
    }
    return this.mcp.handle(msg, ctx);
  }

  async tool(name, args, principal = ROOT) {
    await this.remember(principal.lattice);
    const r = await this.rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, principal);
    return r.error ? { ok: false, error: r.error.message } : r.result.structuredContent ?? { ok: false, error: r.result.content?.[0]?.text };
  }

  /**
   * Drift detector: storing a new watched state retires proofs built on the old
   * content (by state hash) and immediately re-verifies the gates that reopened —
   * unchanged questions are served from the proof cache.
   */
  async setAutoVerify(state, principal = ROOT) {
    await this.remember(principal.lattice);
    return this.audited(principal.id, "auto_verify", () => this._setAutoVerify(state));
  }

  async _setAutoVerify(state) {
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

  async info(principal = ROOT) {
    await this.remember(principal.lattice);
    return {
      ok: true,
      stats: this.lattice.stats(),
      tools: this.mcp.visible(this.ctxFor(principal)).map(d => d.name),
      settings: this.settings,
      model: this.jev?.model ?? null,
      last_idle_cycle: (await this.ctx.storage.get("last_idle_cycle")) || null,
      auto_verify: !!(await this.ctx.storage.get("auto_verify_state")),
      proof_cache: this.jev?.cache ? { ...this.jev.cache.stats, ttlMs: this.jev.cache.ttlMs } : null
    };
  }
}

async function handleMcp(req, stub, principal) {
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
    const r = await stub.rpc(m, principal);
    if (r) out.push(r);
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}

/** Read a request body as text, stopping at `max` bytes (→ null when over). */
async function readCapped(req, max) {
  const reader = req.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

const result = r => json(r, r?.ok === false ? (/^forbidden/.test(r.error || "") ? 403 : /^quota/.test(r.error || "") ? 429 : 400) : 200);

/** Key management: root only. */
const BACKUP_RETENTION_DAYS = 30;

async function gzipJson(obj) {
  return new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
async function gunzipJson(body) {
  return JSON.parse(await new Response(body.pipeThrough(new DecompressionStream("gzip"))).text());
}

/** Back up every registered lattice to R2: lattices/<name>/<ISO time>.json.gz, then prune old ones. */
export async function backupAll(env) {
  if (!env.BACKUPS) return { ok: false, error: "no BACKUPS R2 binding" };
  const names = await listLattices(env);
  const out = { ok: true, at: new Date().toISOString(), backed_up: 0, failed: [], pruned: 0 };
  for (const { name } of names) {
    try {
      const stub = env.LATTICE.get(env.LATTICE.idFromName(name));
      await stub.remember(name);
      const b = await stub.backup();
      const key = `lattices/${name}/${b.at.replace(/[:.]/g, "-")}.json.gz`;
      await env.BACKUPS.put(key, await gzipJson(b), { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" }, customMetadata: { nodes: String(b.state.nodes.length), audit_rows: String(b.audit.length) } });
      out.backed_up++;
      const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86400e3;
      const listed = await env.BACKUPS.list({ prefix: `lattices/${name}/` });
      const old = listed.objects.filter(o => o.uploaded.getTime() < cutoff).map(o => o.key);
      if (old.length) { await env.BACKUPS.delete(old); out.pruned += old.length; }
    } catch (e) {
      out.failed.push({ name, error: e.message });
    }
  }
  console.log(JSON.stringify({ event: "backup", ...out }));
  return out;
}

async function handleAdmin(req, env, principal, parts) {
  if (!principal.root) return json({ ok: false, error: "forbidden: key management needs the root key" }, 403);
  if (!env.CONTROL) return json({ ok: false, error: "no CONTROL D1 binding configured" }, 501);
  const ip = req.headers.get("cf-connecting-ip");
  if (parts[1] === "lattices" && req.method === "GET") return json({ ok: true, lattices: await listLattices(env) });
  if (parts[1] === "backup" && req.method === "POST") return json(await backupAll(env));
  if (parts[1] === "backups" && parts[2] && req.method === "GET") {
    if (!env.BACKUPS) return json({ ok: false, error: "no BACKUPS R2 binding" }, 501);
    const l = await env.BACKUPS.list({ prefix: `lattices/${parts[2]}/`, include: ["customMetadata"] });
    return json({ ok: true, backups: l.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded, ...o.customMetadata })) });
  }
  if (parts[1] === "restore" && parts[2] && req.method === "POST") {
    if (!env.BACKUPS || !NAME_RE.test(parts[2])) return json({ ok: false, error: "bad lattice or no BACKUPS binding" }, 400);
    const { key } = (await req.json().catch(() => ({}))) || {};
    if (typeof key !== "string" || !key.startsWith(`lattices/${parts[2]}/`)) return json({ ok: false, error: "key must be one of this lattice's backups" }, 400);
    const obj = await env.BACKUPS.get(key);
    if (!obj) return json({ ok: false, error: "backup not found" }, 404);
    const stub = env.LATTICE.get(env.LATTICE.idFromName(parts[2]));
    const r = await stub.restore(await gunzipJson(obj.body), { ...principal, lattice: parts[2] });
    return json(r, r.ok ? 200 : 400);
  }
  if (parts[1] === "events" && req.method === "GET") return json(await listKeyEvents(env, Number(new URL(req.url).searchParams.get("limit")) || 100));
  if (parts[1] !== "keys") return json({ ok: false, error: "not found" }, 404);
  if (req.method === "POST" && !parts[2]) {
    const r = await createKey(env, (await req.json().catch(() => null)) || {}, { ip });
    return json(r, r.ok ? 201 : 400);
  }
  if (req.method === "GET" && !parts[2]) return json(await listKeys(env));
  if (req.method === "DELETE" && parts[2]) {
    const r = await revokeKey(env, parts[2], { ip });
    return json(r, r.ok ? 200 : 404);
  }
  return json({ ok: false, error: "not found" }, 404);
}

/** One Analytics Engine data point per API request (absent binding → no-op). */
function metric(env, { route, lattice, tenant, status, ms, tool }) {
  try {
    env.METRICS?.writeDataPoint({ blobs: [route, lattice || "", tenant || "", String(status), tool || ""], doubles: [ms, status >= 500 ? 1 : 0], indexes: [tenant || "anon"] });
  } catch { /* metrics never break requests */ }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(backupAll(env));
  },

  async fetch(req, env, ctx) {
    const t0 = Date.now();
    const rid = crypto.randomUUID();
    let res;
    try {
      res = await route(req, { ...env, waitUntil: p => ctx?.waitUntil?.(p) });
    } catch (e) {
      console.error(JSON.stringify({ event: "unhandled", rid, path: new URL(req.url).pathname, error: e.message, stack: e.stack?.split("\n").slice(0, 4) }));
      res = json({ ok: false, error: "internal error", request_id: rid }, 500);
    }
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    if (["mcp", "api", "admin"].includes(parts[0])) {
      metric(env, { route: parts[0] === "api" ? `api/${parts[2] || ""}` : parts[0], lattice: parts[1], status: res.status, ms: Date.now() - t0, tool: parts[0] === "api" && parts[2] === "tool" ? parts[3] : null });
      res = new Response(res.body, res);
      res.headers.set("x-request-id", rid);
    }
    return res;
  }
};

async function route(req, env) {
  {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/health") return json({ ok: true, server: SERVER_INFO });
    if (url.pathname === "/") return Response.redirect(new URL("/browser/", url).href, 302);

    if (parts[0] === "mcp" || parts[0] === "api" || parts[0] === "admin") {
      const auth = await authenticate(req, env);
      if (!auth.ok) {
        const lim = await limitFailedAuth(env, req);
        if (!lim.ok) return json({ ok: false, error: lim.error }, 429, { "retry-after": "10" });
        return json({ ok: false, error: auth.error }, auth.status, { "www-authenticate": "Bearer" });
      }
      let principal = auth.principal;
      // bound request size before parsing: the declared length, and the actual bytes (chunked uploads have none)
      const max = Number(env.JEV_MAX_BODY_BYTES) || 4 * 1024 * 1024;
      if (Number(req.headers.get("content-length") || 0) > max) return json({ ok: false, error: `request body exceeds ${max} bytes` }, 413);
      if (req.body) {
        const text = await readCapped(req, max);
        if (text === null) return json({ ok: false, error: `request body exceeds ${max} bytes` }, 413);
        req = new Request(req, { body: text });
      }

      if (parts[0] === "admin") return handleAdmin(req, env, principal, parts);

      const name = parts[0] === "mcp" ? parts[1] || "default" : parts[1];
      if (!name || !NAME_RE.test(name)) return json({ ok: false, error: "bad lattice name" }, 400);
      if (!canAccessLattice(principal, name)) return json({ ok: false, error: `this key cannot access lattice "${name}"` }, 403);
      principal = { ...principal, lattice: name };
      const limited = await rateLimit(env, principal);
      if (!limited.ok) return json({ ok: false, error: limited.error }, 429, { "retry-after": "60" });
      const stub = env.LATTICE.get(env.LATTICE.idFromName(name));

      if (parts[0] === "mcp") return handleMcp(req, stub, principal);

      const [, , kind, arg] = parts;
      const need = scope => (hasScope(principal, scope) ? null : json({ ok: false, error: `forbidden: needs scope "${scope}"` }, 403));
      const body = async () => req.json().catch(() => undefined);
      if (kind === "stats" && req.method === "GET") return need("read") || json(await stub.info(principal));
      if (kind === "state" && req.method === "GET") return json(await stub.tool("jev_export_state", {}, principal));
      if (kind === "state" && req.method === "PUT") return result(await stub.tool("jev_import_state", { state: await body() }, principal));
      if (kind === "audit" && req.method === "GET") {
        return result(await stub.tool("jev_audit", { limit: Number(url.searchParams.get("limit")) || 50, ...(url.searchParams.get("node") ? { node: url.searchParams.get("node") } : {}) }, principal));
      }
      if (kind === "settings" && req.method === "GET") return need("read") || json(await stub.getSettings());
      if (kind === "settings" && req.method === "PUT") return need("admin") || result(await stub.putSettings(await body(), principal));
      if (kind === "auto-verify" && req.method === "PUT") return need("admin") || json(await stub.setAutoVerify(await body(), principal));
      if (kind === "auto-verify" && req.method === "DELETE") return need("admin") || json(await stub.setAutoVerify(null, principal));
      if (kind === "idle" && req.method === "POST") return need("admin") || json(await stub.runIdleCycle(principal));
      if (kind === "tool" && arg && req.method === "POST") return result(await stub.tool(arg, (await body()) ?? {}, principal));
      return json({ ok: false, error: "not found" }, 404);
    }
    return env.ASSETS.fetch(req);
  }
}

