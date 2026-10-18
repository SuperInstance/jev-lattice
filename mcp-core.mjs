/**
 * Transport-agnostic MCP layer: tool definitions + JSON-RPC dispatch.
 * Used by mcp-server.mjs (stdio) and worker/ (Streamable HTTP on Cloudflare).
 *
 * No Node built-ins here — runs in Workers and browsers too.
 */
import { createToolRegistry, SCHEMA } from "./jev-core.js";
import * as orch from "./orchestrator.mjs";

export const SERVER_INFO = { name: "jev-lattice", version: "0.7.0" };
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PROOF_SCHEMA = {
  type: "object",
  properties: {
    source_type: {
      type: "string",
      description: "LLM_CHAIN_OF_THOUGHT | DETERMINISTIC_PARSER | SENSOR | SMALL_MODEL | LATTICE_READ | JEV_NOUL | …"
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    cost_weight: { type: "number", minimum: 0, maximum: 1 },
    provider: { type: "string", description: "Distinguishes independent paths of the same source_type" },
    independence_key: { type: "string", description: "Proofs sharing a key count as one path" },
    note: { type: "string" }
  },
  required: ["source_type", "confidence"]
};

const SPEC_SCHEMA = {
  type: "object",
  properties: {
    evaluation_mode: { type: "string", enum: ["BINARY", "COORDINATED"] },
    required_independent_proofs: { type: "number" },
    confidence_threshold: { type: "number" },
    intent: { type: "string" },
    max_proof_age_ms: { type: "number" },
    allowed_sources: { type: "array", items: { type: "string" } },
    reads: { type: "array", items: { type: "string" }, description: "Evidence files this question depends on (per-file drift; Jev sees only these)" },
    blocked_sources: { type: "array", items: { type: "string" }, description: "Source types that may not count toward this gate" },
    block_on_conflict: { type: "boolean" },
    source_thresholds: { type: "object", additionalProperties: { type: "number" }, description: "Per source_type thresholds, e.g. {\"SMALL_MODEL\": 0.99}" }
  }
};

const ID = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const EMPTY = { type: "object", properties: {} };
const CHANNEL_ARG = { type: "string", description: "Name of the evidence source (e.g. a file path). Recorded on proofs so jev_invalidate_stale can retire exactly the ones built on old content." };
const STATE_ARG = {
  description: "System One state: text or JSON the verifier reads (config, log, diff…). Defaults to the lattice neighborhood.",
  type: ["string", "object", "array"]
};

/**
 * Minimal JSON-Schema check for tool arguments (the subset our inputSchemas use:
 * type / required / properties / items / enum / minimum / maximum /
 * additionalProperties-as-schema). Returns null or "path: problem".
 */
export function validateArgs(schema, value, path = "arguments") {
  if (!schema || typeof schema !== "object") return null;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  const typeOf = v => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  if (types) {
    const t = typeOf(value);
    const ok = types.some(x => x === t || (x === "integer" && t === "number" && Number.isInteger(value)) || (x === "number" && t === "number" && Number.isFinite(value)));
    if (!ok) return `${path}: expected ${types.join(" | ")}, got ${t}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path}: must be one of ${schema.enum.join(", ")}`;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: must be ≥ ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: must be ≤ ${schema.maximum}`;
  }
  if (typeOf(value) === "object") {
    for (const k of schema.required || []) if (value[k] === undefined) return `${path}.${k}: required`;
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : null);
      const err = sub && validateArgs(sub, v, `${path}.${k}`);
      if (err) return err;
    }
  }
  if (typeOf(value) === "array" && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validateArgs(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Curated tool profiles (T39). An agent given 6 tools instead of 23 made 33% fewer calls
 * and stopped "refuting" unknowable requirements from absence of evidence.
 */
export const PROFILES = {
  gatekeeper: ["jev_ingest", "jev_verify_files", "jev_verify_open", "jev_evaluate_go_no_go", "jev_list_nodes", "jev_get_node"],
  reader: ["jev_evaluate_go_no_go", "jev_list_nodes", "jev_get_node", "jev_query", "jev_stats", "jev_export_state", "jev_audit"]
};

export const isMutating = name => MUTATING.has(name);

const MUTATING = new Set([
  "jev_ingest", "jev_add_proof", "jev_invalidate_proof", "jev_consolidate", "jev_import_state",
  "jev_boost", "jev_prune", "jev_verify", "jev_verify_open", "jev_minimax_proof", "jev_decompose",
  "jev_rollup", "jev_compile", "jev_edge_proof", "jev_invalidate_stale", "jev_predicate_proof", "jev_verify_files", "jev_teach", "jev_sense_probe", "jev_apply_learned"
]);

export function toolDefs({ hasJev = false, hasMiniMax = false, hasCapacity = false, hasSmall = false, hasPredicates = false, hasSenses = false } = {}) {
  const defs = [
    { name: "jev_ingest", description: "Ingest text as OBSERVATION or QUESTION. For questions pass question_spec (BINARY|COORDINATED) and optional initial proof.",
      inputSchema: { type: "object", properties: {
        text: { type: "string" }, tags: { type: "array", items: { type: "string" } },
        node_type: { type: "string", enum: ["OBSERVATION", "QUESTION"] },
        question_spec: SPEC_SCHEMA, proof: PROOF_SCHEMA }, required: ["text"] } },
    { name: "jev_add_proof", description: "Append an independent proof to a QUESTION node. Updates multi-proof salience and go/no-go.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, proof: PROOF_SCHEMA }, required: ["id", "proof"] } },
    { name: "jev_invalidate_proof", description: "Kill one verification path (e.g. its evidence changed). The gate re-evaluates on the remaining paths.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, proof_id: { type: "string" }, reason: { type: "string" } }, required: ["id", "proof_id"] } },
    { name: "jev_evaluate_go_no_go", description: "Deterministic gate. Verdict GO | OPEN | REFUTED | CONFLICT. BINARY needs one proof ≥ threshold; COORDINATED needs k independent ones.",
      inputSchema: ID },
    { name: "jev_query", description: "Spatial + probabilistic beam search over the lattice. Prefers closed/low-cost paths.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, topK: { type: "number" }, beam: { type: "number" } } } },
    { name: "jev_consolidate", description: "Idle cycle: stitch edges, soft-merge observations, prune low-salience, mark open questions seeking_verification.", inputSchema: EMPTY },
    { name: "jev_stats", description: "Lattice stats: nodes, questions, open gates, edges, averages.", inputSchema: EMPTY },
    { name: "jev_list_nodes", description: "List node summaries (id, text, type, verdict).", inputSchema: EMPTY },
    { name: "jev_get_node", description: "Get full node by id.", inputSchema: ID },
    { name: "jev_boost", description: "Raise a node's salience.", inputSchema: { type: "object", properties: { id: { type: "string" }, delta: { type: "number" } }, required: ["id"] } },
    { name: "jev_prune", description: "Delete a node and its edges.", inputSchema: ID },
    { name: "jev_invalidate_stale", description: "Drift invalidation by content hash: retire proofs whose recorded evidence (in `channel`) differs from `state`. Proofs on unchanged evidence stay valid.",
      inputSchema: { type: "object", properties: { state: STATE_ARG, files: { type: "object", additionalProperties: { type: "string" }, description: "Per-file form: retire proofs whose recorded file hashes changed" }, channel: CHANNEL_ARG, reason: { type: "string" } } } },
    { name: "jev_rollup", description: "Deterministic: if all child sub-questions are GO, add a cheap LATTICE_READ proof to the parent (or a refuting one if a child is REFUTED).", inputSchema: ID },
    { name: "jev_export_state", description: `Export full lattice JSON (schema ${SCHEMA}).`, inputSchema: EMPTY },
    { name: "jev_import_state", description: "Import lattice JSON state (replaces current).",
      inputSchema: { type: "object", properties: { state: { type: "object" } }, required: ["state"] } }
  ];
  if (hasCapacity) {
    defs.push({ name: "jev_capacity", description: "Report host capacity probe and current policy tier.", inputSchema: EMPTY });
  }
  if (hasJev) {
    defs.push(
      { name: "jev_verify", description: "Ask TypeSafe Jev (calibrated System One model) whether a QUESTION holds given `state`; appends a cheap JEV_NOUL proof.",
        inputSchema: { type: "object", properties: { id: { type: "string" }, state: STATE_ARG, instructions: { type: "string" }, channel: CHANNEL_ARG }, required: ["id"] } },
      { name: "jev_verify_files", description: "Per-file verification: `files` = {path: content}. Each open question sees only the files in its question_spec.reads; proofs record per-file hashes.",
        inputSchema: { type: "object", properties: { files: { type: "object", additionalProperties: { type: "string" } }, ids: { type: "array", items: { type: "string" } }, rules: { type: "string" } }, required: ["files"] } },
      { name: "jev_verify_open", description: "Speculative fan-out: verify every open QUESTION against one shared `state` in a single Jev request. Answers are cached by (state hash, question) when a cache is configured.",
        inputSchema: { type: "object", properties: { state: STATE_ARG, ids: { type: "array", items: { type: "string" } }, channel: CHANNEL_ARG } } }
    );
  }
  if (hasMiniMax) {
    defs.push(
      { name: "jev_minimax_proof", description: "Expensive discovery path: MiniMax chain-of-thought judges the question; appends an LLM_CHAIN_OF_THOUGHT proof.",
        inputSchema: { type: "object", properties: { id: { type: "string" }, state: STATE_ARG }, required: ["id"] } },
      { name: "jev_decompose", description: "MiniMax splits a QUESTION into atomic BINARY sub-questions linked as children.",
        inputSchema: { type: "object", properties: { id: { type: "string" }, maxSub: { type: "number" } }, required: ["id"] } }
    );
  }
  if (hasSmall) {
    defs.push({ name: "jev_edge_proof", description: "Independent SMALL_MODEL proof from an on-edge model (Cloudflare Workers AI).",
      inputSchema: { type: "object", properties: { id: { type: "string" }, state: STATE_ARG }, required: ["id"] } });
  }
  if (hasPredicates) {
    defs.push(
      { name: "jev_predicate_register", description: "Register model-written code `(text) => boolean` for a question. Runs in a sandboxed isolate; accepted only if it matches every label.",
        inputSchema: { type: "object", properties: {
          question: { type: "string" }, code: { type: "string" },
          labels: { type: "array", items: { type: "object", properties: { text: { type: "string" }, expected: { type: "boolean" } }, required: ["text", "expected"] } }
        }, required: ["question", "code", "labels"] } },
      { name: "jev_predicate_proof", description: "Run a QUESTION's compiled predicate on `text` (sandboxed) and append a DETERMINISTIC_PARSER proof. A compiled YES is 0.8 (a hint), a NO is 0.01.",
        inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, question: { type: "string" }, channel: CHANNEL_ARG }, required: ["id", "text"] } }
    );
  }
  if (hasSenses) {
    const FILES = { type: "object", additionalProperties: { type: "string" } };
    defs.push(
      { name: "jev_teach", description: "Cross-sense teaching: for each DECIDED question, run the weaker senses (jev-whole, jev-paraphrase, workers-ai, compiled) on the same `files` and bank (p, verdict) as a label.",
        inputSchema: { type: "object", properties: { files: FILES, ids: { type: "array", items: { type: "string" } }, senses: { type: "array", items: { type: "string" } }, rules: { type: "string" } }, required: ["files"] } },
      { name: "jev_sense_report", description: "Per question × sense: accuracy and Brier against teacher labels, and the learned safe threshold (or why there is none).",
        inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, minSamples: { type: "number" }, minGo: { type: "number" }, floor: { type: "number", description: "learned thresholds may only go below this…" }, minGoForDiscount: { type: "number", description: "…with at least this many clean GOs in the bank" }, teacherErrorRate: { type: "number", minimum: 0, maximum: 0.5, description: "measured flip rate of the teacher; forgives the disagreements such a teacher would plausibly cause (0 = strict)" } } } },
      { name: "jev_sense_probe", description: "Run senses with no teacher; return p per question per sense. addProofs=true appends SENSE:<name> proofs.",
        inputSchema: { type: "object", properties: { files: FILES, ids: { type: "array", items: { type: "string" } }, senses: { type: "array", items: { type: "string" } }, addProofs: { type: "boolean" }, rules: { type: "string" } }, required: ["files"] } },
      { name: "jev_apply_learned", description: "Write learned per-sense thresholds into each question's spec (source_thresholds) and block senses with no safe threshold (blocked_sources).",
        inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, minSamples: { type: "number" }, minGo: { type: "number" }, floor: { type: "number", description: "learned thresholds may only go below this…" }, minGoForDiscount: { type: "number", description: "…with at least this many clean GOs in the bank" }, teacherErrorRate: { type: "number", minimum: 0, maximum: 0.5, description: "measured flip rate of the teacher; forgives the disagreements such a teacher would plausibly cause (0 = strict)" } } } }
    );
  }
  if (hasJev || hasMiniMax) {
    defs.push({ name: "jev_compile", description: "Progressive compilation for one question: Jev first → MiniMax CoT → decompose + Jev fan-out → roll-up. Stops when decided.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, state: STATE_ARG }, required: ["id"] } });
  }
  return defs;
}

/**
 * @param {object} o
 * @param {import('./jev-core.js').JEVLattice} o.lattice
 * @param {object} [o.jev]  providers/jev.mjs client
 * @param {object} [o.mm]   providers/minimax.mjs client
 * @param {object} [o.small] small/edge model client with json() (Workers AI)
 * @param {object} [o.predicates] sandboxed compiled-predicate store (worker/predicates.mjs)
 * @param {object} [o.senses] cross-sense teaching suite (senses.mjs createSenseSuite)
 * @param {() => object} [o.capacity]  harness snapshot fn (Node only)
 * @param {() => object} [o.consolidateOpts]
 * @param {() => Promise<void>|void} [o.persist] called after mutating tools
 */
export function createMcp({
  lattice, jev = null, mm = null, small = null, predicates = null, senses = null, capacity = null,
  consolidateOpts = () => ({}), persist = null,
  profile = null,        // default tool profile (PROFILES key) for every request
  extraTools = []        // [{ def, handler(args) , mutating? }] host-specific tools (e.g. audit)
}) {
  const tools = createToolRegistry(lattice);
  const defs = [...toolDefs({ hasJev: !!jev, hasMiniMax: !!mm, hasCapacity: !!capacity, hasSmall: !!small, hasPredicates: !!predicates, hasSenses: !!senses }), ...extraTools.map(t => t.def)];
  const extra = new Map(extraTools.map(t => [t.def.name, t]));
  for (const t of extraTools) if (t.mutating) MUTATING.add(t.def.name);
  const names = new Set(defs.map(d => d.name));
  /** Tools visible for this request: profile ∩ allow(). */
  const visible = (ctx = {}) => {
    const prof = ctx.profile ?? profile;
    const inProfile = prof && PROFILES[prof] ? new Set(PROFILES[prof]) : null;
    return defs.filter(d => (!inProfile || inProfile.has(d.name)) && (!ctx.allow || ctx.allow(d.name) === true));
  };

  async function callTool(name, args = {}) {
    if (!names.has(name)) return { ok: false, error: `unknown tool: ${name}` };
    if (extra.has(name)) return extra.get(name).handler(args);
    switch (name) {
      case "jev_ingest": return tools.ingest(args);
      case "jev_add_proof": return tools.addProof({ id: args.id, proof: args.proof });
      case "jev_invalidate_proof": return tools.invalidateProof(args);
      case "jev_evaluate_go_no_go": return tools.evaluateGoNoGo({ id: args.id });
      case "jev_query": return tools.query(args);
      case "jev_consolidate": return tools.consolidate(consolidateOpts());
      case "jev_stats": {
        const st = capacity ? { ...tools.stats(), capacity: capacity() } : tools.stats();
        return jev?.cache ? { ...st, proofCache: { ...jev.cache.stats, ttlMs: jev.cache.ttlMs } } : st;
      }
      case "jev_invalidate_stale": {
        // file-map form: { files } → per-file invalidation; otherwise whole-state hash
        if (args.files) return orch.invalidateChangedFiles(lattice, { files: args.files, reason: args.reason });
        return orch.invalidateStale(lattice, { state: args.state, channel: args.channel, reason: args.reason });
      }
      case "jev_verify_files": return orch.verifyFiles(lattice, { jev, files: args.files, ids: args.ids, rules: args.rules });
      case "jev_list_nodes":
        return { ok: true, nodes: lattice.listNodes().map(n => lattice._nodeSummary(n)).map(s => ({ ...s, verdict: s.node_type === "QUESTION" ? lattice.evaluateGoNoGo(s.id).verdict : undefined })) };
      case "jev_get_node": return tools.getNode({ id: args.id });
      case "jev_boost": return tools.boost(args);
      case "jev_prune": return tools.prune(args);
      case "jev_rollup": return orch.rollup(lattice, args.id);
      case "jev_export_state": return tools.exportState();
      case "jev_import_state": return tools.importState({ state: args.state });
      case "jev_capacity": return { ok: true, ...capacity() };
      case "jev_verify": return orch.verifyWithJev(lattice, args.id, { jev, state: args.state, instructions: args.instructions, channel: args.channel });
      case "jev_verify_open": return orch.verifyOpenGates(lattice, { jev, state: args.state, ids: args.ids, channel: args.channel });
      case "jev_minimax_proof": return orch.proveWithMiniMax(lattice, args.id, { mm, state: args.state });
      case "jev_decompose": return orch.decompose(lattice, args.id, { mm, maxSub: args.maxSub });
      case "jev_compile": return orch.compile(lattice, args.id, { jev, mm, state: args.state });
      case "jev_teach": return senses.teach(lattice, args);
      case "jev_sense_report": return senses.report(lattice, args);
      case "jev_sense_probe": return senses.probe(lattice, args);
      case "jev_apply_learned": return senses.apply(lattice, args);
      case "jev_predicate_register": return predicates.register(args);
      case "jev_predicate_proof": return predicates.proof(lattice, args.id, { text: args.text, question: args.question, channel: args.channel });
      case "jev_edge_proof":
        return orch.proveWithLLM(lattice, args.id, { llm: small, state: args.state, source_type: "SMALL_MODEL", provider: small.provider, cost_weight: 0.15 });
    }
  }

  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  /** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
  /**
   * ctx (optional, per request): { allow(name) → true | "reason", guard(name, args) → null | "reason", profile }
   */
  async function handle(msg, ctx = {}) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return fail(msg?.id ?? null, -32600, "Invalid Request");
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null; // notifications/initialized, cancelled, …

    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return ok(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "JEV lattice: store QUESTIONs with explicit proof contracts, add independent proofs, and read the deterministic go/no-go verdict. " +
            "Prefer cheap verifiers (jev_verify) before expensive ones (jev_minimax_proof)."
        });
      }
      case "ping": return ok(msg.id, {});
      case "tools/list": return ok(msg.id, { tools: visible(ctx) });
      case "tools/call": {
        const name = msg.params?.name;
        if (!names.has(name)) return fail(msg.id, -32602, `Unknown tool: ${name}`);
        const args = msg.params?.arguments ?? {};
        const refuse = reason => {
          const result = { ok: false, error: reason };
          return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true });
        };
        if (!visible(ctx).some(d => d.name === name)) {
          const why = ctx.allow ? ctx.allow(name) : true;
          return refuse(why === true ? `forbidden: ${name} is not in the "${ctx.profile ?? profile}" tool profile` : `forbidden: ${why}`);
        }
        const invalid = validateArgs(defs.find(d => d.name === name).inputSchema, args);
        if (invalid) {
          const result = { ok: false, error: `invalid arguments — ${invalid}` };
          return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true });
        }
        const blocked = ctx.guard ? await ctx.guard(name, args) : null;
        if (blocked) return refuse(blocked);
        try {
          const result = await callTool(name, args);
          if (MUTATING.has(name) && persist && result?.ok !== false) await persist();
          return ok(msg.id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: result?.ok === false
          });
        } catch (e) {
          return ok(msg.id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return { handle, callTool, defs, visible };
}
