# Security policy

## Reporting
Please report vulnerabilities privately through GitHub Security Advisories on this repository ("Report a vulnerability"), not in public issues.

## Model
- **Gates fail closed.** Missing evidence, verifier errors and unverified questions are never GO.
- **Secrets:**
  - API keys come from the environment (`TYPESAFE_AI_TOKEN`, `MINIMAX_TOKEN`) or Worker secrets (`wrangler secret put`). They never appear in state or logs.
  - `.dev.vars` and state files are gitignored, and CI runs GitGuardian.
- **Worker:**
  - `/mcp` and `/api` require `Authorization: Bearer $JEV_API_KEY` and refuse all requests when the key isn't configured.
  - The key comparison is constant-time.
  - Request bodies are capped (`JEV_MAX_BODY_BYTES`).
  - **Known gap:** there is a single shared key, with no per-tenant scopes or rate limits yet (see docs/PRODUCTION.md §4, P0).
- **Model-written code** runs only in Dynamic Worker isolates, with no bindings, no outbound network and a CPU limit. `node:vm` is used only by local experiments and is **not** a security boundary.
- **Data sent to third parties:**
  - The files a gate `reads` go to TypeSafe.
  - Optional providers receive questions and evidence: MiniMax (decompose, CoT, paraphrase) and Workers AI (on Cloudflare).
  - Only configure the providers you're willing to send evidence to.
- **Tool input:** every MCP tool call is validated against its schema before dispatch.

## Supported versions
Only the latest minor version receives fixes before v1.0.
