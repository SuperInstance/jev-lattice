#!/usr/bin/env node
/**
 * JEV Lattice MCP Server
 * Exposes question-graph tools over Model Context Protocol (stdio JSON-RPC).
 *
 * Usage:
 *   node mcp-server.mjs
 *   # or via MCP client config pointing at this command
 *
 * Tools mirror jev-core: ingest, addProof, evaluateGoNoGo, query,
 * consolidate, stats, exportState, importState, listNodes, getNode.
 */

import { JEVLattice, createToolRegistry, SCHEMA } from "./jev-core.js";
import { createHarness } from "./harness.mjs";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

const STATE_PATH = process.env.JEV_STATE_PATH || path.join(process.cwd(), "jev-state.json");

const lattice = new JEVLattice();
const tools = createToolRegistry(lattice);
const harness = createHarness();

// Load prior state if present
if (fs.existsSync(STATE_PATH)) {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    tools.importState({ state: raw });
    process.stderr.write(`[jev-mcp] loaded state from ${STATE_PATH} (${lattice.listNodes().length} nodes)\n`);
  } catch (e) {
    process.stderr.write(`[jev-mcp] failed to load state: ${e.message}\n`);
  }
}

function persist() {
  try {
    const state = tools.exportState();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(`[jev-mcp] persist error: ${e.message}\n`);
  }
}

const TOOL_DEFS = [
  {
    name: "jev_ingest",
    description:
      "Ingest text as OBSERVATION or QUESTION. For questions pass question_spec (BINARY|COORDINATED) and optional initial proof.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        node_type: { type: "string", enum: ["OBSERVATION", "QUESTION"] },
        question_spec: {
          type: "object",
          properties: {
            evaluation_mode: { type: "string", enum: ["BINARY", "COORDINATED"] },
            required_independent_proofs: { type: "number" },
            confidence_threshold: { type: "number" },
            intent: { type: "string" }
          }
        },
        proof: {
          type: "object",
          properties: {
            source_type: { type: "string" },
            confidence: { type: "number" },
            cost_weight: { type: "number" },
            note: { type: "string" }
          }
        }
      },
      required: ["text"]
    }
  },
  {
    name: "jev_add_proof",
    description: "Append an independent proof to a QUESTION node. Updates multi-proof salience and go/no-go.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        proof: {
          type: "object",
          properties: {
            source_type: { type: "string" },
            confidence: { type: "number" },
            cost_weight: { type: "number" },
            note: { type: "string" }
          },
          required: ["source_type", "confidence"]
        }
      },
      required: ["id", "proof"]
    }
  },
  {
    name: "jev_evaluate_go_no_go",
    description:
      "Deterministic gate: BINARY needs one proof ≥ threshold; COORDINATED needs k independent proofs ≥ threshold.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "jev_query",
    description: "Spatial + probabilistic beam search over the lattice. Prefers closed/low-cost paths.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        topK: { type: "number" },
        beam: { type: "number" }
      }
    }
  },
  {
    name: "jev_consolidate",
    description:
      "Idle cycle: stitch edges, soft-merge observations, prune low-salience, mark open coordinated questions as seeking_verification. Intensity follows capacity policy.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "jev_stats",
    description: "Lattice stats: nodes, questions, open gates, edges, averages.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "jev_list_nodes",
    description: "List all nodes (summaries).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "jev_get_node",
    description: "Get full node by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "jev_export_state",
    description: "Export full lattice JSON (schema jev-lattice/v0.2).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "jev_import_state",
    description: "Import lattice JSON state (replaces current).",
    inputSchema: {
      type: "object",
      properties: { state: { type: "object" } },
      required: ["state"]
    }
  },
  {
    name: "jev_capacity",
    description: "Report harness capacity probe and current policy (compute/storage/memory tier).",
    inputSchema: { type: "object", properties: {} }
  }
];

function callTool(name, args = {}) {
  const policy = harness.policy();
  switch (name) {
    case "jev_ingest":
      return tools.ingest(args);
    case "jev_add_proof":
      return tools.addProof({ id: args.id, proof: args.proof });
    case "jev_evaluate_go_no_go":
      return tools.evaluateGoNoGo({ id: args.id });
    case "jev_query":
      return tools.query(args);
    case "jev_consolidate": {
      if (!policy.allowConsolidate) {
        return { ok: true, skipped: true, reason: "capacity policy deferred consolidation", policy };
      }
      const opts = policy.consolidateOpts || {};
      return tools.consolidate(opts);
    }
    case "jev_stats":
      return { ...tools.stats(), capacity: harness.snapshot() };
    case "jev_list_nodes":
      return tools.listNodes();
    case "jev_get_node":
      return tools.getNode({ id: args.id });
    case "jev_export_state":
      return tools.exportState();
    case "jev_import_state":
      return tools.importState({ state: args.state });
    case "jev_capacity":
      return { ok: true, ...harness.snapshot() };
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return;

  // JSON-RPC style (MCP-compatible subset)
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "jev-lattice", version: "0.2.0", schema: SCHEMA }
      }
    });
    return;
  }

  if (msg.method === "notifications/initialized" || msg.method === "initialized") {
    return;
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOL_DEFS }
    });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    try {
      const result = callTool(name, args);
      // Persist after mutating ops
      if (
        [
          "jev_ingest",
          "jev_add_proof",
          "jev_consolidate",
          "jev_import_state"
        ].includes(name)
      ) {
        persist();
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        }
      });
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: e.message }
      });
    }
    return;
  }

  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  // Unknown method
  if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  try {
    handle(JSON.parse(t));
  } catch (e) {
    process.stderr.write(`[jev-mcp] parse error: ${e.message}\n`);
  }
});

process.stderr.write(
  `[jev-mcp] ready schema=${SCHEMA} state=${STATE_PATH} tier=${harness.policy().tier}\n`
);
