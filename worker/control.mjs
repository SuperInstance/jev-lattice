/**
 * Control plane for JEV Edge: tenants, API keys, scopes, rate limits.
 *
 * Keys look like  jev_<id>_<secret>. Only sha256(secret) is stored (D1, binding CONTROL).
 * The deployment secret JEV_API_KEY remains the bootstrap ROOT key: all scopes, all lattices,
 * and the only principal allowed to manage keys.
 *
 * Scopes are cumulative:  read ⊂ verify ⊂ admin.
 *   read    inspect: stats, export, list, evaluate, query, audit, sense reports
 *   verify  add evidence: ingest, proofs, verification, invalidation, teaching
 *   admin   change the lattice wholesale or its policy: import, prune, settings, predicates,
 *           auto-verify, applying learned thresholds
 * Lattice access: each key lists name patterns ("acme-*", "shared"); "*" means all.
 */
import { sha256Hex } from "../proof-cache.mjs";
import { PROFILES } from "../mcp-core.mjs";

export const SCOPES = ["read", "verify", "admin"];
const RANK = { read: 1, verify: 2, admin: 3 };

const READ_TOOLS = new Set([
  "jev_evaluate_go_no_go", "jev_query", "jev_stats", "jev_list_nodes", "jev_get_node",
  "jev_export_state", "jev_sense_report", "jev_capacity", "jev_audit", "jev_settings"
]);
const ADMIN_TOOLS = new Set([
  "jev_import_state", "jev_prune", "jev_boost", "jev_predicate_register", "jev_apply_learned", "jev_consolidate"
]);
/** Scope a tool needs. Anything not read or admin adds evidence → verify. */
export function toolScope(name) {
  return READ_TOOLS.has(name) ? "read" : ADMIN_TOOLS.has(name) ? "admin" : "verify";
}
export const hasScope = (principal, scope) => SCOPES.some(s => principal.scopes.includes(s) && RANK[s] >= RANK[scope]);

export function canAccessLattice(principal, name) {
  return principal.lattices.some(p => p === "*" || p === name || (p.endsWith("*") && name.startsWith(p.slice(0, -1))));
}

function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

let schemaReady = null;
export function ensureSchema(db) {
  schemaReady ||= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, tenant TEXT NOT NULL, scopes TEXT NOT NULL,
      lattices TEXT NOT NULL, profile TEXT, label TEXT, created_at TEXT NOT NULL, revoked_at TEXT)`),
    // append-only record of key management (who issued / revoked what, from where)
    db.prepare(`CREATE TABLE IF NOT EXISTS key_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, key_id TEXT NOT NULL,
      tenant TEXT, detail TEXT, ip TEXT)`)
  ]).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

/**
 * → { ok: true, principal } | { ok: false, status, error }
 * principal = { id, tenant, scopes[], lattices[], profile, root }
 */
export async function authenticate(req, env) {
  const h = req.headers.get("authorization") || "";
  if (h.length > 512) return { ok: false, status: 401, error: "invalid token" };
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, error: "missing bearer token" };
  // compare against root even when unset, so timing doesn't reveal whether a root key exists
  const isRoot = constantTimeEqual(token, env.JEV_API_KEY || "\u0000no-root-key") && !!env.JEV_API_KEY;
  if (isRoot) return { ok: true, principal: { id: "root", tenant: "root", scopes: ["admin"], lattices: ["*"], profile: null, root: true } };
  const m = token.match(/^jev_([a-z0-9]{12})_([A-Za-z0-9_-]{20,128})$/);
  if (!m || !env.CONTROL) return { ok: false, status: 401, error: "invalid token" };
  await ensureSchema(env.CONTROL);
  // hash before the lookup, so a known and an unknown key id take the same path
  const hash = await sha256Hex(m[2]);
  const row = await env.CONTROL.prepare("SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL").bind(m[1]).first();
  if (!constantTimeEqual(hash, row?.key_hash || "0".repeat(64)) || !row) return { ok: false, status: 401, error: "invalid token" };
  let scopes, lattices;
  try {
    scopes = JSON.parse(row.scopes);
    lattices = JSON.parse(row.lattices);
  } catch {
    return { ok: false, status: 401, error: "invalid token" };
  }
  if (!Array.isArray(scopes) || !Array.isArray(lattices)) return { ok: false, status: 401, error: "invalid token" };
  return { ok: true, principal: { id: row.id, tenant: row.tenant, scopes, lattices, profile: row.profile || null, root: false } };
}

/** Failed authentications are rate-limited per client IP (keys are limited per key id). */
export async function limitFailedAuth(env, req) {
  if (!env.RATE_LIMITER) return { ok: true };
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: `authfail:${ip}` });
  return success ? { ok: true } : { ok: false, status: 429, error: "too many failed authentications" };
}

async function keyEvent(env, action, keyId, tenant, detail, ip) {
  await env.CONTROL.prepare("INSERT INTO key_events (at, action, key_id, tenant, detail, ip) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), action, keyId, tenant ?? null, detail ? JSON.stringify(detail) : null, ip ?? null).run();
}

export async function listKeyEvents(env, limit = 100) {
  await ensureSchema(env.CONTROL);
  const { results } = await env.CONTROL.prepare("SELECT * FROM key_events ORDER BY seq DESC LIMIT ?").bind(Math.min(Math.max(1, limit), 1000)).all();
  return { ok: true, events: results.map(e => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })) };
}

const randomString = (n, alphabet) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join("");
};

export async function createKey(env, { tenant, scopes = ["read"], lattices, profile = null, label = null } = {}, { ip = null } = {}) {
  if (!tenant || !/^[a-z0-9-]{1,40}$/.test(tenant)) return { ok: false, error: "tenant: lowercase letters, digits, dashes (≤ 40)" };
  if (!Array.isArray(scopes) || !scopes.length || !scopes.every(s => SCOPES.includes(s))) return { ok: false, error: `scopes: subset of ${SCOPES.join(", ")}` };
  const pats = Array.isArray(lattices) && lattices.length ? lattices.map(String) : [`${tenant}-*`];
  if (!pats.every(p => /^[a-zA-Z0-9_*-]{1,64}$/.test(p))) return { ok: false, error: "lattices: name patterns like acme-* or shared" };
  if (profile !== null && !PROFILES[profile]) return { ok: false, error: `profile: null or one of ${Object.keys(PROFILES).join(", ")}` };
  await ensureSchema(env.CONTROL);
  const id = randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789");
  const secret = randomString(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  await env.CONTROL.prepare("INSERT INTO api_keys (id, key_hash, tenant, scopes, lattices, profile, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(secret), tenant, JSON.stringify(scopes), JSON.stringify(pats), profile, label, new Date().toISOString()).run();
  await keyEvent(env, "create", id, tenant, { scopes, lattices: pats, profile, label }, ip);
  return { ok: true, id, key: `jev_${id}_${secret}`, tenant, scopes, lattices: pats, profile, note: "store this key now; only its hash is kept" };
}

export async function listKeys(env) {
  await ensureSchema(env.CONTROL);
  const { results } = await env.CONTROL.prepare("SELECT id, tenant, scopes, lattices, profile, label, created_at, revoked_at FROM api_keys ORDER BY created_at DESC").all();
  return { ok: true, keys: results.map(r => ({ ...r, scopes: JSON.parse(r.scopes), lattices: JSON.parse(r.lattices) })) };
}

export async function revokeKey(env, id, { ip = null } = {}) {
  await ensureSchema(env.CONTROL);
  const r = await env.CONTROL.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), id).run();
  const ok = (r.meta?.changes || 0) > 0;
  if (ok) await keyEvent(env, "revoke", id, null, null, ip);
  return { ok, revoked: id };
}

/** Per-key rate limit (Workers rate-limiting binding; absent binding → unlimited). */
export async function rateLimit(env, principal) {
  if (!env.RATE_LIMITER || principal.root) return { ok: true };
  const { success } = await env.RATE_LIMITER.limit({ key: `key:${principal.id}` });
  return success ? { ok: true } : { ok: false, status: 429, error: "rate limit exceeded for this key" };
}

// ---------- per-lattice settings ----------
export const PROVIDERS = ["typesafe", "minimax", "workers-ai", "predicates"];

export function defaultSettings(env) {
  const n = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const maxNodes = n(env.JEV_MAX_NODES, 5000);
  return {
    providers: String(env.JEV_DEFAULT_PROVIDERS ?? "typesafe").split(",").map(x => x.trim()).filter(Boolean),
    profile: null,
    max_nodes: maxNodes,
    max_proofs_per_node: n(env.JEV_MAX_PROOFS_PER_NODE, 200),
    max_proofs: n(env.JEV_MAX_PROOFS, maxNodes * 20)
  };
}

/** Merge a settings patch; → { ok, settings } | { ok: false, error }. */
export function mergeSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "settings must be an object" };
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "providers") {
      if (!Array.isArray(v) || !v.every(p => PROVIDERS.includes(p))) return { ok: false, error: `providers: subset of ${PROVIDERS.join(", ")}` };
      out.providers = [...new Set(v)];
    } else if (k === "profile") {
      if (v !== null && !PROFILES[v]) return { ok: false, error: `profile: null or one of ${Object.keys(PROFILES).join(", ")}` };
      out.profile = v;
    } else if (["max_nodes", "max_proofs_per_node", "max_proofs"].includes(k)) {
      if (!Number.isInteger(v) || v < 1 || v > 1e6) return { ok: false, error: `${k}: integer in [1, 1000000]` };
      out[k] = v;
    } else return { ok: false, error: `unknown setting: ${k}` };
  }
  return { ok: true, settings: out };
}
