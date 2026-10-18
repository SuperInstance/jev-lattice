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

## Tools

See main README for full list. Names are prefixed `jev_` on the wire:

- `jev_ingest`, `jev_add_proof`, `jev_invalidate_proof`, `jev_evaluate_go_no_go`
- `jev_query`, `jev_consolidate`, `jev_stats`, `jev_rollup`
- `jev_list_nodes`, `jev_get_node`, `jev_boost`, `jev_prune`
- `jev_export_state`, `jev_import_state`
- `jev_capacity` (stdio only)
- with providers: `jev_verify`, `jev_verify_open`, `jev_minimax_proof`, `jev_decompose`, `jev_compile`, `jev_edge_proof` (Worker only)

Mutating calls persist state to `JEV_STATE_PATH`.

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
