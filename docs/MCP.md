# MCP Server

`mcp-server.mjs` speaks a JSON-RPC subset compatible with MCP tool hosts over **stdio**.

## Run

```bash
node mcp-server.mjs
```

Environment:

| Variable | Default | Meaning |
|----------|---------|---------|
| `JEV_STATE_PATH` | `./jev-state.json` | Persist/load lattice |
| `JEV_TIER` | auto | `minimal` \| `standard` \| `high` |
| `TYPESAFE_AI_TOKEN` | — | enables `jev_verify`, `jev_verify_open`, `jev_compile` |
| `MINIMAX_TOKEN` | — | enables `jev_minimax_proof`, `jev_decompose`, `jev_compile` |
| `JEV_NO_PROVIDERS` | — | `1` hides provider tools (offline / tests) |
| `JEV_CACHE` | on | `0` disables the (state hash, question) proof cache |
| `JEV_CACHE_TTL_MS` | 86400000 | proof-cache entry lifetime |
| `JEV_PROFILE` | all tools | `gatekeeper` (6 tools: ingest, verify_files, verify_open, evaluate, list, get) or `reader` (read-only) |
| `JEV_MODEL` | `jev-latest` | pin the Jev model, e.g. `jev-1.13.0`; verdicts move a few percent across versions |

## Tools

Names are prefixed `jev_` on the wire. Availability depends on what's configured: tools whose provider is missing are not listed.

| tool | needs | arguments (required in **bold**) | what it does |
|---|---|---|---|
| `jev_ingest` | — | **text**, tags, node_type, question_spec, proof | Create an OBSERVATION or a QUESTION |
| `jev_add_proof` | — | **id**, **proof** | Append a proof (latest per path counts) |
| `jev_invalidate_proof` | — | **id**, **proof_id**, reason | Kill one path; kept for audit |
| `jev_invalidate_stale` | — | state *or* files, channel, reason | Drift: retire proofs whose recorded evidence hash changed |
| `jev_evaluate_go_no_go` | — | **id** | Verdict + margin + fragile |
| `jev_list_nodes` / `jev_get_node` | — | / **id** | Summaries with verdicts / the full node |
| `jev_query` | — | text, tags, topK, beam | Beam search over the graph |
| `jev_consolidate` | — | — | Idle cycle |
| `jev_rollup` | — | **id** | Children → parent `LATTICE_READ` proof |
| `jev_boost` / `jev_prune` | — | **id** | Housekeeping |
| `jev_stats` | — | — | Counts (+ capacity, cache stats) |
| `jev_export_state` / `jev_import_state` | — | / **state** | Portable snapshot |
| `jev_capacity` | stdio | — | Host probe + policy tier |
| `jev_verify` | Jev | **id**, state, instructions, channel | One question → `JEV_NOUL` proof |
| `jev_verify_open` | Jev | state, ids, channel | All open questions, one shared state, one call |
| `jev_verify_files` | Jev | **files**, ids, rules, quarantine, facts | Per-file evidence via `question_spec.reads` (+ `focus`, `criteria`); `facts` = {path: [extractor specs]} |
| `jev_minimax_proof` | MiniMax | **id**, state | LLM chain-of-thought proof |
| `jev_decompose` | MiniMax | **id**, maxSub | Sub-questions as BINARY children |
| `jev_compile` | Jev or MiniMax | **id**, state | Cheap-first loop: Jev → MiniMax → decompose → roll-up |
| `jev_edge_proof` | Worker (Workers AI) | **id**, state | `SMALL_MODEL` proof |
| `jev_predicate_register` | Worker (Loader) | **question**, **code**, **labels** | Sandboxed predicate, validated in its isolate |
| `jev_predicate_proof` | Worker (Loader) | **id**, **text**, question, channel | Compiled YES = 0.8 (hint), NO = 0.01 |
| `jev_teach` | Jev (Worker) | **files**, ids, senses, rules | Decided gates label each sense's reading |
| `jev_sense_report` | Jev (Worker) | ids, minSamples, minGo, floor, minGoForDiscount, teacherErrorRate | Per question × sense reliability + learned bar |
| `jev_sense_probe` | Jev (Worker) | **files**, ids, senses, addProofs, rules | Run senses with no teacher |
| `jev_apply_learned` | Jev (Worker) | ids, minSamples, minGo, floor, minGoForDiscount, teacherErrorRate | Write learned bars / blocks into each spec |
| `jev_audit` | Worker | limit, node | Verdict-change log: actor, tool, which gates moved |
| `jev_settings` | Worker | — | Enabled providers, default profile, quotas, pinned model |

## Tool profiles and authorisation
`createMcp({ profile })` (stdio: `JEV_PROFILE`) limits the tool surface; `handle(msg, ctx)` accepts a per-request `ctx = { allow(name) → true | reason, guard(name, args) → null | reason, profile }`. `tools/list` returns only the tools that are both in the profile and allowed. A call to any other tool returns an MCP result with `isError: true` and `forbidden: …` (or `quota: …` from `guard`), never a protocol error, so agents can read why. The Worker builds `ctx` from the caller's key (scopes, profile) and the lattice's quotas. *Why profiles:* in R4-E the 6-tool surface made 33% fewer calls and kept unknowable gates OPEN 7/8 times vs 3/8 (T39).

Mutating calls persist state: to `JEV_STATE_PATH` on stdio, to Durable Object storage on the Worker (where each one is also written to the audit log).

## Example session (conceptual)

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"jev_ingest",
  "arguments":{
    "text":"Is REDIS_TLS_PORT 6380?",
    "node_type":"QUESTION",
    "question_spec":{
      "evaluation_mode":"BINARY",
      "required_independent_proofs":1,
      "confidence_threshold":0.9
    },
    "proof":{"source_type":"DETERMINISTIC_PARSER","confidence":0.99,"cost_weight":0.01}
  }
}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
  "name":"jev_evaluate_go_no_go",
  "arguments":{"id":"<node id from ingest>"}
}}
```

## Client config sketch

```json
{
  "mcpServers": {
    "jev-lattice": {
      "command": "node",
      "args": ["/path/to/jev-lattice/mcp-server.mjs"],
      "env": {
        "JEV_STATE_PATH": "/var/lib/jev/state.json",
        "JEV_TIER": "standard"
      }
    }
  }
}
```

## Remote (Cloudflare)

The same tools are served over HTTP at `POST /mcp/:lattice`. See [CLOUDFLARE.md](CLOUDFLARE.md).

## Notes

- The protocol version is negotiated (`2025-06-18`, `2025-03-26`, `2024-11-05`). Notifications get no response.
- Tool failures return `isError: true` together with `structuredContent`. An unknown tool returns error `-32602`, and a malformed line returns `-32700`; the server keeps serving after both.
- Messages are handled serially, and state is written with write-then-rename so a crash can't truncate the file.
- Tool definitions and dispatch live in `mcp-core.mjs`. The stdio server and the Worker are thin transports over it.
