#!/usr/bin/env node
/**
 * Load test a deployed Worker (use staging). No provider calls: ingest / add_proof / evaluate / list.
 *   node scripts/load-worker.mjs <url> <root key> [--concurrency 20] [--requests 400] [--big 5000]
 * Reports latency percentiles per phase and errors. --big N imports an N-question lattice and times
 * a mutating call (audit snapshot over every gate), a read, and the idle cycle.
 */
const [base, key] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const opt = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const C = opt("--concurrency", 20), N = opt("--requests", 400), BIG = opt("--big", 5000);
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const L = `load-${Date.now().toString(36)}`;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const report = (name, ms, errors) => console.log(`${name.padEnd(34)} n=${ms.length} p50=${pct(ms, 0.5)}ms p95=${pct(ms, 0.95)}ms p99=${pct(ms, 0.99)}ms max=${Math.max(...ms)}ms errors=${errors}`);
async function call(lattice, name, args) {
  const t0 = Date.now();
  const r = await fetch(`${base}/mcp/${lattice}`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const j = await r.json().catch(() => ({}));
  return { ms: Date.now() - t0, ok: r.ok && !j.error && !j.result?.isError, j };
}
// phase 1: concurrent mixed traffic on one lattice (one Durable Object = one writer)
const ids = [];
for (let i = 0; i < 20; i++) ids.push((await call(L, "jev_ingest", { text: `Is requirement ${i} met?`, question_spec: { confidence_threshold: 0.9 }, linkToNearest: false })).j.result.structuredContent.node.id);
const ms = { write: [], read: [] }; let errors = 0, next = 0;
await Promise.all(Array.from({ length: C }, async () => {
  while (next < N) {
    const i = next++;
    const write = i % 3 === 0;
    const r = write
      ? await call(L, "jev_add_proof", { id: ids[i % ids.length], proof: { source_type: `S${i % 5}`, confidence: Math.random() } })
      : await call(L, i % 3 === 1 ? "jev_evaluate_go_no_go" : "jev_list_nodes", { id: ids[i % ids.length] });
    (write ? ms.write : ms.read).push(r.ms);
    if (!r.ok) errors++;
  }
}));
report(`concurrent ×${C}: add_proof (audited)`, ms.write, errors);
report(`concurrent ×${C}: evaluate / list`, ms.read, 0);
// phase 2: a big lattice
if (BIG) {
  const BL = `${L}-big`;
  const nodes = Array.from({ length: BIG }, (_, i) => ({ id: `q${i}`, node_type: "QUESTION", text: `Is requirement ${i} met?`, question_spec: { confidence_threshold: 0.9 }, active_proofs: [{ proof_id: `p${i}`, source_type: "PARSER", confidence: i % 2 ? 0.97 : 0.4, timestamp: new Date().toISOString() }] }));
  let t0 = Date.now();
  const imp = await fetch(`${base}/api/${BL}/state`, { method: "PUT", headers: H, body: JSON.stringify({ nodes }) });
  console.log(`import ${BIG} questions: HTTP ${imp.status} in ${Date.now() - t0}ms (${(JSON.stringify({ nodes }).length / 1e6).toFixed(1)} MB)`);
  const w = [], r = [];
  for (let i = 0; i < 10; i++) w.push((await call(BL, "jev_add_proof", { id: `q${i}`, proof: { source_type: "X", confidence: 0.99 } })).ms);
  for (let i = 0; i < 10; i++) r.push((await call(BL, "jev_evaluate_go_no_go", { id: `q${i}` })).ms);
  report(`${BIG}-question lattice: add_proof`, w, 0);
  report(`${BIG}-question lattice: evaluate`, r, 0);
  t0 = Date.now();
  const idle = await fetch(`${base}/api/${BL}/idle`, { method: "POST", headers: H });
  console.log(`idle cycle (consolidate ${BIG}): HTTP ${idle.status} in ${Date.now() - t0}ms`);
  await fetch(`${base}/api/${BL}/state`, { method: "PUT", headers: H, body: JSON.stringify({ nodes: [] }) });
}
