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

## Tools

See main README for full list. Names are prefixed `jev_` on the wire:

- `jev_ingest`, `jev_add_proof`, `jev_evaluate_go_no_go`
- `jev_query`, `jev_consolidate`, `jev_stats`
- `jev_list_nodes`, `jev_get_node`
- `jev_export_state`, `jev_import_state`
- `jev_capacity`

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

## Notes

- This is a **minimal stdio MCP tool server**, not a full SDK binding. Hosts that speak MCP tools/list + tools/call work.  
- For production hardening, wrap with the official MCP SDK transport if your host requires negotiated capabilities beyond this subset.  
- The lattice schema and tool semantics remain the source of truth; the MCP layer is an adapter.
