import test from "node:test";
import assert from "node:assert/strict";
import { toolScope, hasScope, canAccessLattice, authenticate, createKey, listKeys, revokeKey, rateLimit, defaultSettings, mergeSettings } from "../worker/control.mjs";

/** Minimal D1 stand-in: enough SQL for the api_keys table. */
function fakeD1() {
  const rows = new Map(), events = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (sql.startsWith("INSERT INTO key_events")) {
        events.push(args);
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("INSERT")) {
        const [id, key_hash, tenant, scopes, lattices, profile, label, created_at] = args;
        rows.set(id, { id, key_hash, tenant, scopes, lattices, profile, label, created_at, revoked_at: null });
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("UPDATE")) {
        const r = rows.get(args[1]);
        if (!r || r.revoked_at) return { meta: { changes: 0 } };
        r.revoked_at = args[0];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    },
    async first() { const r = rows.get(args[0]); return r && !r.revoked_at ? r : null; },
    async all() { return { results: sql.includes("key_events") ? events.map(([at, action, key_id, tenant, detail, ip]) => ({ at, action, key_id, tenant, detail, ip })) : [...rows.values()] }; }
  });
  return { rows, events, prepare: sql => stmt(sql.trim()), batch: async () => [] };
}
const req = token => new Request("https://x/", { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("tool scopes and the read ⊂ verify ⊂ admin order", () => {
  assert.equal(toolScope("jev_list_nodes"), "read");
  assert.equal(toolScope("jev_add_proof"), "verify");
  assert.equal(toolScope("jev_import_state"), "admin");
  assert.equal(toolScope("jev_something_new"), "verify", "unknown tools default to verify, not read");
  const verifier = { scopes: ["verify"] };
  assert.ok(hasScope(verifier, "read") && hasScope(verifier, "verify") && !hasScope(verifier, "admin"));
});

test("lattice patterns", () => {
  const p = { lattices: ["acme-*", "shared"] };
  assert.ok(canAccessLattice(p, "acme-prod") && canAccessLattice(p, "shared"));
  assert.ok(!canAccessLattice(p, "globex-prod") && !canAccessLattice(p, "shared2"));
  assert.ok(canAccessLattice({ lattices: ["*"] }, "anything"));
});

test("keys: create → authenticate → revoke; root and bad tokens", async () => {
  const env = { JEV_API_KEY: "root-secret", CONTROL: fakeD1() };
  assert.equal((await authenticate(req(null), env)).status, 401);
  assert.equal((await authenticate(req("nope"), env)).status, 401);
  assert.ok((await authenticate(req("root-secret"), env)).principal.root);
  assert.equal((await createKey(env, { tenant: "Bad Tenant" })).ok, false);
  assert.equal((await createKey(env, { tenant: "acme", scopes: ["owner"] })).ok, false);
  const k = await createKey(env, { tenant: "acme", scopes: ["verify"], profile: "gatekeeper" });
  assert.ok(k.ok && k.key.startsWith(`jev_${k.id}_`));
  assert.deepEqual(k.lattices, ["acme-*"], "default lattice pattern is the tenant prefix");
  const a = await authenticate(req(k.key), env);
  assert.equal(a.principal.tenant, "acme");
  assert.equal(a.principal.profile, "gatekeeper");
  assert.equal((await authenticate(req(k.key.slice(0, -1) + (k.key.endsWith("A") ? "B" : "A")), env)).status, 401, "wrong secret");
  assert.ok(!JSON.stringify((await listKeys(env)).keys).includes(k.key.split("_")[2]), "secrets are never listed");
  assert.ok((await revokeKey(env, k.id)).ok);
  assert.equal((await authenticate(req(k.key), env)).status, 401, "revoked");
  assert.equal((await revokeKey(env, k.id)).ok, false);
});

test("rate limit: root exempt, keys limited, no binding = unlimited", async () => {
  let calls = 0;
  const env = { RATE_LIMITER: { limit: async () => ({ success: ++calls < 3 }) } };
  const p = { id: "abc", root: false };
  assert.ok((await rateLimit(env, p)).ok);
  assert.ok((await rateLimit(env, p)).ok);
  assert.equal((await rateLimit(env, p)).status, 429);
  assert.ok((await rateLimit(env, { root: true })).ok);
  assert.ok((await rateLimit({}, p)).ok);
});

test("settings: defaults from env, validated patches", () => {
  const d = defaultSettings({ JEV_MAX_NODES: "100" });
  assert.deepEqual(d.providers, ["typesafe"]);
  assert.equal(d.max_proofs, 2000);
  assert.deepEqual(mergeSettings(d, { providers: ["typesafe", "minimax"] }).settings.providers, ["typesafe", "minimax"]);
  assert.equal(mergeSettings(d, { providers: ["openai"] }).ok, false);
  assert.equal(mergeSettings(d, { profile: "nope" }).ok, false);
  assert.equal(mergeSettings(d, { profile: "gatekeeper" }).settings.profile, "gatekeeper");
  assert.equal(mergeSettings(d, { max_nodes: 0 }).ok, false);
  assert.equal(mergeSettings(d, { colour: "red" }).ok, false);
});

test("auth hardening: long tokens, corrupted rows, profiles, key events", async () => {
  const { listKeyEvents } = await import("../worker/control.mjs");
  const env = { JEV_API_KEY: "root-secret", CONTROL: fakeD1() };
  assert.equal((await authenticate(req(`jev_abcdefghijkl_${"a".repeat(200)}`), env)).status, 401, "secret over 128 chars");
  assert.equal((await authenticate(req("x".repeat(600)), env)).status, 401);
  assert.equal((await createKey(env, { tenant: "acme", profile: "everything" })).ok, false);
  const k = await createKey(env, { tenant: "acme", scopes: ["read"] }, { ip: "1.2.3.4" });
  env.CONTROL.rows.get(k.id).scopes = "{not json";
  assert.equal((await authenticate(req(k.key), env)).status, 401, "corrupted row fails closed, not 500");
  await revokeKey(env, k.id, { ip: "1.2.3.4" });
  const ev = await listKeyEvents(env);
  assert.deepEqual(ev.events.map(e => e.action), ["create", "revoke"]);
  assert.equal(ev.events[0].ip, "1.2.3.4");
  assert.equal((await authenticate(req("root-secret"), { CONTROL: fakeD1() })).status, 401, "no root key configured → root token is just invalid");
});
