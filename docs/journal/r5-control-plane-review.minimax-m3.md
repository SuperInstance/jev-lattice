# Security Review: JEV Edge Control Plane

## 1. Unauthenticated CPU/D1 exhaustion — auth runs before rate limit, and `sha256Hex` runs on every request

**Code path:** `worker/index.mjs` lines ~205–217 (the `fetch` handler) calls `authenticate(req, env)` *before* `rateLimit(...)`. Inside `authenticate` (`worker/control.mjs` ~57–75), any token that matches the regex `^jev_([a-z0-9]{12})_([A-Za-z0-9_-]{20,})$` triggers a D1 `SELECT` and a `sha256Hex(m[2])` (full SHA-256 over the secret). The regex's secret class `{20,}` has no upper bound. There is no IP-based or unauthenticated rate limit.

**Exploit:** With no key, repeatedly:
```
POST /api/default/tool/jev_query HTTP/1.1
Authorization: Bearer jev_aaaaaaaaaaaa_<random 8KB of [A-Za-z0-9_-]>
```
Each request does one D1 read + one 8KB SHA-256 + one `constantTimeEqual` over 8KB. Multiply by thousands of concurrent requests — D1 read budget and Worker CPU are exhausted without ever passing auth, and the `env.RATE_LIMITER` binding is never consulted (it keys on `principal.id`).

**Severity:** **Medium** (configurable to High with aggressive traffic; D1 read quota and CPU time are real, billable limits).

**Fix:** (a) Anchor a max length: `^jev_([a-z0-9]{12})_([A-Za-z0-9_-]{20,128})$`. (b) Reject `content-length > small_value` (e.g. 8KB) for `/admin/*` and for requests whose `Authorization` header is overlong, *before* `authenticate`. (c) Add an IP-keyed `RATE_LIMITER.limit({ key: \`ip:${req.cf?.clientIp}\` })` as the first check, independent of `principal.id`.

---

## 2. `Content-Length` size limit trivially bypassed — DoS via huge body

**Code path:** `worker/index.mjs`:
```js
const max = Number(env.JEV_MAX_BODY_BYTES) || 4 * 1024 * 1024;
if (Number(req.headers.get("content-length") || 0) > max) return json({...}, 413);
```
`req.headers.get("content-length")` returns `null` when the header is omitted. `Number(null || 0)` is `0`, so the guard is skipped. An attacker can send `Transfer-Encoding: chunked` with no `Content-Length` and stream up to the Worker request body cap (~100MB) into `req.json()` / `stub.tool(...)`.

**Exploit:**
```
PUT /api/acme-prod/state HTTP/1.1
Host: ...
Authorization: Bearer jev_aaaaaaaaaaaa_<valid>
Transfer-Encoding: chunked

<stream 100MB of valid-looking JSON>
```
The 100MB is buffered in `req.json()` and again in the DO's tool handler. Memory pressure / Worker memory limit exceeded.

**Severity:** **Medium** (DoS; degrades to High if other tenants share the isolate).

**Fix:** Don't trust `content-length`. Stream the body and count bytes, or call `req.arrayBuffer()` and check `.byteLength`, *or* wrap `req.json()` in a manual size-capped reader:
```js
const buf = await readBodyCapped(req, max);
if (!buf) return json({...}, 413);
```
Same fix needed at the `/mcp` POST path (`handleMcp` → `req.json()`).

---

## 3. Audit-log `node` filter is a LIKE wildcard sink — broken security control

**Code path:** `worker/index.mjs`, `LatticeDO.auditLog`:
```js
sql.exec("SELECT * FROM audit WHERE changes LIKE ? ORDER BY seq DESC LIMIT ?",
  `%"id":${JSON.stringify(String(node))}%`, limit)
```
`JSON.stringify` only quotes the string; it does not escape `%` or `_`. SQLite `LIKE` treats those as wildcards, and `_` matches any single character.

**Exploit (read-scope tenant, shared lattice):**
```
GET /api/shared/audit?node=%25 HTTP/1.1
Authorization: Bearer jev_...<read scope, pattern includes "shared">
```
The bound pattern becomes `%"id":"%"%`; the middle `%` matches everything, so the tenant sees the full 500-entry window instead of a single node. With `node=_` they sweep every 1-character node id.

The tenant can already `GET /api/shared/audit` with no `node` to see all entries on a lattice they can access, so the direct confidentiality impact is small — but the control is broken, and a future change that *does* rely on `node` as a restrictive filter (e.g. cross-tenant logging) would be silently bypassed.

**Severity:** **Low** (broken filter; no cross-tenant data leak today).

**Fix:** Escape `%`, `_`, and the escape char itself before binding:
```js
const esc = String(node).replace(/[\\%_]/g, c => "\\" + c);
sql.exec("SELECT * FROM audit WHERE changes LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?",
  `%"id":${JSON.stringify(esc)}%`, limit);
```

---

## 4. `runIdleCycle` and `getSettings` lose the caller identity in audit

**Code path:** `worker/index.mjs`:
```js
if (kind === "idle" && req.method === "POST") return need("admin") || json(await stub.runIdleCycle());
...
if (kind === "settings" && req.method === "GET") return need("read") || json(await stub.getSettings());
```
Neither call passes `principal`. The DO methods default `principal = ROOT`, so `runIdleCycle` → `alarm()` records `actor = "system:idle"` for whatever the admin tenant triggered, and the per-tenant `principal.id` is dropped. The settings GET is unaudited, but the route already enforces scope, so the only loss is attribution.

**Exploit:** Admin tenant A triggers `POST /api/acme-prod/idle`; the auto-verify pass that follows is logged as `actor: "system:idle"` instead of A's key id. If A is later compromised and denies the action, the audit cannot attribute it.

**Severity:** **Low** (attribution only; the action still happened and is visible in the audit; the compromise/denial scenario requires the actor to be hostile, which the audit is for).

**Fix:** Thread the caller into the DO: `json(await stub.runIdleCycle(principal))`, and inside `runIdleCycle` record an explicit `audited(principal.id, "idle", ...)` entry that wraps the alarm, *or* include the trigger in the existing audit row's `changes` field.

---

## 5. Timing oracle for valid key IDs (pre-hash short-circuit)

**Code path:** `worker/control.mjs`, `authenticate`:
```js
const row = await env.CONTROL.prepare("SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL").bind(m[1]).first();
if (!row || !constantTimeEqual(await sha256Hex(m[2]), row.key_hash)) return {...401};
```
A non-existent `id` returns before `sha256Hex` runs. A live `id` runs the SHA-256 (~tens of µs for 20+ char secrets). D1 round-trip latency already dominates, so the signal is weak, but it exists per-request and is repeatable.

**Exploit:** Attacker with many tokens of the form `jev_<guess>_<fixed-secret>` measures response time. Live IDs take ~tens of µs longer. Combined with Cloudflare's edge placement, the signal is noisy but cumulative across many requests.

**Severity:** **Low** (62-bit ID space; impractical in isolation, but the pattern is a textbook username-enumeration oracle).

**Fix:** Always run `sha256Hex` before the D1 lookup, *or* do a dummy `sha256Hex` in the no-row branch:
```js
const row = await env.CONTROL.prepare(...).bind(m[1]).first();
const expected = row ? row.key_hash : "0".repeat(64);
const ok = !!row && constantTimeEqual(await sha256Hex(m[2]), expected);
if (!ok) return { ok:false, status:401, error:"invalid token" };
```

---

## 6. Root-key presence is leaked via timing

**Code path:** `worker/control.mjs`:
```js
if (env.JEV_API_KEY && constantTimeEqual(token, env.JEV_API_KEY)) { ... root ... }
```
`env.JEV_API_KEY` is checked with a short-circuit `&&` before the (constant-time) compare. An attacker sending a malformed token measures whether the request returns a root-style response path or the regex path. The two paths have different latency (regex vs. constantTimeEqual + D1).

**Exploit:** Not directly useful — the attacker can't read the root key — but reveals deployment configuration (`JEV_API_KEY` is configured) and is a deviation from the constant-time property claimed by the function.

**Severity:** **Low** (information leak, not privilege escalation).

**Fix:** Always run `constantTimeEqual` against `env.JEV_API_KEY ?? ""` and let the `false` short-circuit; keep the boolean out of the timing path.

---

## 7. Quota guard is trivially bypassable for `jev_import_state` when `state.nodes` is not an array

**Code path:** `worker/index.mjs`, `LatticeDO.quota`:
```js
if (name === "jev_import_state" && (args.state?.nodes?.length || 0) > s.max_nodes) return `quota: ...`;
```
`null.length` and `{}.length` are `undefined`; `undefined || 0` is `0`; `0 > 5000` is false. The check only fires when `args.state.nodes` is an array-like with `.length`.

**Exploit:** An admin tenant with a 1MB `state` that has `nodes` as an object whose enumerable properties are merged by the lattice importer — or a non-array iterable — skips the node-count check entirely. Without `jev-core.js` I can't confirm the importer actually accepts that shape, so the post-quota behavior is uncertain: it may throw (loud) or merge unboundedly (silent). I am **not sure** this is exploitable for an actual quota bypass; the worst confirmed outcome is a 500.

**Severity:** **Low** (potential DoS / uncertain quota bypass).

**Fix:** Validate the shape first:
```js
if (name === "jev_import_state") {
  const nodes = args?.state?.nodes;
  if (!Array.isArray(nodes) || nodes.length > s.max_nodes)
    return `quota: import has ${Array.isArray(nodes)?nodes.length:0} nodes (max_nodes ${s.max_nodes})`;
}
```

---

## 8. `principal.scopes` / `principal.lattices` are `JSON.parse`d without a try/catch — auth DoS

**Code path:** `worker/control.mjs`, `authenticate`:
```js
return { ok:true, principal:{ ..., scopes: JSON.parse(row.scopes), lattices: JSON.parse(row.lattices), ... } };
```
A single corrupted `scopes` or `lattices` value (operational mistake, partial migration, future code path that writes a non-string) makes every authentication for that key throw and the request return 500. Only root can write the table, so a tenant can't trigger it, but a root mistake locks every caller using that key out of *every* route with a 500 and an unhandled promise rejection.

**Exploit:** Not tenant-triggerable today; flagged because a future code path that uses `profile`, `label`, or any new column for routing would inherit the same fragility.

**Severity:** **Low** (robustness, not exploitable by tenants today).

**Fix:**
```js
let scopes, lattices;
try { scopes = JSON.parse(row.scopes); lattices = JSON.parse(row.lattices); }
catch { return { ok:false, status:401, error:"invalid token" }; }
if (!Array.isArray(scopes) || !Array.isArray(lattices)) return { ok:false, status:401, error:"invalid token" };
```

---

## 9. Root key is not invalidated/rotatable; revocation path is the only key lifecycle tool, and there is no audit of key creation/revocation

**Code path:** `worker/index.mjs`, `handleAdmin`:
```js
if (req.method === "POST" && !parts[2]) { ...createKey... }
if (req.method === "GET"  && !parts[2]) { ...listKeys... }
if (req.method === "DELETE" && parts[2]) { ...revokeKey... }
```
The `/admin/*` routes have **no audit log entry** of their own. Tenant keys are created, listed, and revoked without any record in the D1 `api_keys` table (beyond `created_at` / `revoked_at`) and with no record in any per-lattice audit (the audit lives in the LatticeDO, not the control plane). If root is compromised, the attacker can mint, list, and revoke keys with no trace, and the only forensic signal is `created_at` / `revoked_at` timestamps on the row.

**Exploit:** A compromised root key creates `admin`-scope keys for an attacker-controlled tenant with `lattices: ["*"]`, then revokes nothing. The control-plane D1 row is the only record. There is no separate immutable audit.

**Severity:** **Low** (requires root compromise; the threat model says root is trusted, so this is about defense-in-depth).

**Fix:** Write every `/admin/*` mutation to a `key_audit` D1 table (actor, action, target_id, at, request_ip) that is append-only and readable only by root. Optionally also emit a structured log line.

---

## 10. `canAccessLattice` allows a key with `lattices: ["*"]` to enumerate *all* lattice names by ID-timing and DO-creation

**Code path:** `worker/control.mjs`:
```js
export function canAccessLattice(principal, name) {
  return principal.lattices.some(p => p === "*" || p === name || (p.endsWith("*") && name.startsWith(p.slice(0, -1))));
}
```
A tenant key with `lattices: ["*"]` is admitted by `createKey` (the regex `^[a-zA-Z0-9_*-]{1,64}$` allows `*`, and the function does not require `principal.root` to set it — but only root can call `createKey` today, so issuance is gated). However, once such a key exists, the holder can probe `GET /api/<guess>/stats` for arbitrary `name`; every probed name instantiates a fresh Durable Object on first access, billable to the account. There is no rate limit on the *unauthorized* access attempt — only on successful auth — so the probe loop is also unrate-limited per finding #1.

**Exploit:**
```
for n in $(cat wordlist); do
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer jev_<id>_<secret>" \
    "https://.../api/$n/stats"
done
```
Distinct status codes (`200` first-touch vs. `403`/`200` on subsequent) leak which names are real lattices.

**Severity:** **Low** (lattice names are not secret by design; the cost is the DO churn, mitigated by `canAccessLattice` already gating this — the issue is that `createKey` accepts `["*"]` for non-root issuers *if the call site ever changes*, and there is no per-IP rate limit on the auth path).

**Fix:** (a) In `createKey`, require `env.JEV_API_KEY` match (or a new `principal.root` check parameter) when `lattices` contains `"*"`. (b) Combine with the IP-keyed rate limit from #1.

---

### Things I checked and did *not* find exploitable
- D1 / DO SQL injection: all queries are parameterized.
- Cross-tenant DO routing: `canAccessLattice` runs before `env.LATTICE.get(...)`.
- Scope escalation: `principal.scopes` is read from D1, only root can write.
- Audit forgery/erasure: `audited` always uses server-derived `principal.id`; no client endpoint writes to the audit table.
- Prototype pollution in `mergeSettings`: the unknown-key branch rejects `__proto__`, `constructor`, etc.
- ReDoS: all regexes are linear/anchored.
