# Guide: agents and MCP integrations

**Audience:** you are wiring the lattice into an agent (Claude Code, Cursor, a custom agent loop, or an Anthropic-format tool loop on any provider) and want it to make gated decisions instead of opinions.

## 1. Pick a transport

| | stdio (`mcp-server.mjs`) | HTTP (Cloudflare Worker) |
|---|---|---|
| Where state lives | a JSON file (`JEV_STATE_PATH`) | a Durable Object per lattice name |
| Who can reach it | the local agent process | any client with the bearer key |
| Extra tools | `jev_capacity` (host probe) | `jev_edge_proof` (Workers AI), `jev_predicate_*` (sandboxed code), `jev_teach` / `jev_sense_*` / `jev_apply_learned` |
| Best for | one developer, CI jobs | shared lattices, several agents, long-lived watches |

**stdio:**
```json
{ "mcpServers": { "jev-lattice": {
  "command": "node", "args": ["/abs/path/jev-lattice/mcp-server.mjs"],
  "env": { "JEV_STATE_PATH": "/abs/path/state.json", "TYPESAFE_AI_TOKEN": "…" } } } }
```

**HTTP** (Streamable HTTP, JSON responses; one lattice per URL path):
```json
{ "mcpServers": { "jev-edge": {
  "type": "http", "url": "https://jev-lattice.<you>.workers.dev/mcp/my-project",
  "headers": { "Authorization": "Bearer <JEV_API_KEY>" } } } }
```

Both transports speak the same tool definitions, which come from `mcp-core.mjs`. Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are negotiated. Tool failures return `isError: true` with `structuredContent`.

## 2. The minimal decision loop

Most agents only need four tools.

1. **`jev_ingest`**: one QUESTION per requirement.
   ```json
   { "text": "Is TLS enabled (a tls-port is configured)?",
     "question_spec": { "confidence_threshold": 0.9, "reads": ["redis.conf"] } }
   ```
2. **`jev_verify_files`**: verify every open question against the files it `reads`, in one batched call per read-set.
   ```json
   { "files": { "redis.conf": "<contents>", "app.env": "<contents>" },
     "rules": "later directives override earlier ones; # lines are comments" }
   ```
3. **`jev_evaluate_go_no_go`** for each question, or **`jev_list_nodes`** for all verdicts at once.
4. On the next run, **`jev_invalidate_stale`** with `{ "files": {…} }` before verifying again. Proofs on unchanged files stay; proofs on changed files are retired.

Report each verdict **exactly** as the lattice returns it (`GO`, `OPEN`, `REFUTED`, `CONFLICT`). Treat `fragile: true` as "decided, but close enough to its bar that a re-read could flip it". Surface that to the user, or add an independent path.

## 3. Prompting an agent to use it well

Measured with a MiniMax agent (`experiments/minimax-agent.mjs`, `experiments/uninstructed-agent.mjs`).

**Explicit instruction works:**
> "For each requirement, create a QUESTION with jev_ingest, verify all of them with ONE jev_verify_open / jev_verify_files call, and report each verdict exactly as returned."

This gave 16/16 correct deploy decisions and 64/64 verdicts relayed verbatim, even when the user pressed it to say GO.

**With a neutral prompt** ("use tools if they help"), the agent still chose the lattice 8/8 times. But it sprawled across about 13 tool calls (vs 5 when instructed), trying predicates, edge proofs and decompositions, and mostly ignored the requested output format.

**Recommendations:**
- **Curate the tool surface.** Expose only what the task needs: `jev_ingest`, `jev_verify_files`, `jev_list_nodes`, `jev_invalidate_stale`. The full set is for operators and experiments.
- **Score agents from the lattice state, not from their prose.** The lattice is the record: `jev_list_nodes` or `jev_export_state` show what was actually decided.
- **Requirements must be decidable from the evidence.** If a property has a default value (e.g. Redis `appendfsync everysec`), say so in the reading rules; otherwise "absent" and "default" get confused.

## 4. Using an Anthropic-format tool loop with any model

`experiments/minimax-agent.mjs` shows the whole pattern in about 60 lines:
```js
const tools = mcp.defs.map(d => ({ name: d.name, description: d.description, input_schema: d.inputSchema }));
// …Messages API loop: for each tool_use block →
const out = await mcp.handle({ jsonrpc: "2.0", id: c.id, method: "tools/call", params: { name: c.name, arguments: c.input } });
// → return out.result.content[0].text as tool_result
```
`mcp` is either `createMcp({ lattice, jev })` in-process, or an HTTP JSON-RPC client pointed at the Worker (as in `experiments/uninstructed-agent.mjs`).

## 5. Tool reference (by job)

| job | tools |
|---|---|
| define decisions | `jev_ingest`, `jev_decompose` (MiniMax → sub-questions), `jev_rollup` |
| gather evidence | `jev_verify_files` (per-file), `jev_verify_open` (one shared state), `jev_verify` (one question), `jev_minimax_proof`, `jev_edge_proof`, `jev_predicate_proof`, `jev_add_proof` (your own verifier) |
| decide | `jev_evaluate_go_no_go`, `jev_list_nodes`, `jev_compile` (cheap-first loop: Jev → MiniMax → decompose → roll-up) |
| keep it current | `jev_invalidate_stale` (`files` or `state`), `jev_invalidate_proof`, `jev_consolidate` |
| learn from decided gates | `jev_teach`, `jev_sense_report`, `jev_sense_probe`, `jev_apply_learned` |
| move state | `jev_export_state`, `jev_import_state` |
| run code safely (edge) | `jev_predicate_register` (validated against labels inside the sandbox) |

Full schemas: `tools/list`, or [../MCP.md](../MCP.md).

## 6. Pitfalls
- **Two Jev proofs are one path.** Under the independence rules, a COORDINATED gate needs *different* verifiers, or explicitly different `provider`s that really are independent.
- **Re-asking won't "fix" an OPEN gate.** With the proof cache, re-asking the same evidence returns the same answer, deliberately. Change the evidence, or add an independent path.
- **Long or structured states:** split them into files (`reads`), or into slices, and combine the per-slice verdicts. Don't multiply probabilities across slices (tile T33).
- **Counting questions** ("at least 3 of …") abstain when asked directly. Decompose them and count.
