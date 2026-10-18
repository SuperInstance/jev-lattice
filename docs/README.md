# Documentation index

## By role
| Role | Read |
|---|---|
| Engineer adding gates to a pipeline | [guides/ci-gates.md](guides/ci-gates.md) → [guides/typesafe.md](guides/typesafe.md) → [GATE-SEMANTICS.md](GATE-SEMANTICS.md) |
| Deciding deployment / packaging | [PRODUCTION.md](PRODUCTION.md) |
| On call for the Worker | [RUNBOOK.md](RUNBOOK.md) |
| Agent / MCP integrator | [guides/agent-integrators.md](guides/agent-integrators.md) → [MCP.md](MCP.md) |
| JS developer embedding the library | [guides/library-api.md](guides/library-api.md) |
| Platform engineer (Cloudflare) | [CLOUDFLARE.md](CLOUDFLARE.md) |
| Researcher / experimenter | [guides/researchers.md](guides/researchers.md) → [RESEARCH-LOG.md](RESEARCH-LOG.md) |
| Core contributor | [../CONTRIBUTING.md](../CONTRIBUTING.md) → [ARCHITECTURE.md](ARCHITECTURE.md) |
| Designing the next tool | [TILES.md](TILES.md) → [JOURNAL.md](JOURNAL.md) |

## By document
| Document | Kind | Contents |
|---|---|---|
| [GATE-SEMANTICS.md](GATE-SEMANTICS.md) | reference (normative) | the exact go/no-go algorithm, fields, margin/fragility, conformance checklist + [vectors](../conformance/gate-vectors.json) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | explanation | layers, data flow, progressive compilation, capacity tiers |
| [MCP.md](MCP.md) | reference | stdio server, environment, all tools |
| [CLOUDFLARE.md](CLOUDFLARE.md) | how-to + reference | Worker routes, keys and scopes, quotas, settings, audit log, storage layout, deploy, operations |
| [PRODUCTION.md](PRODUCTION.md) | assessment + plan | what is production / beta / research, deployment tiers, packaging, prioritised remaining work, cost and failure modes |
| [guides/ci-gates.md](guides/ci-gates.md) | how-to | `jev gate` config, CLI, GitHub Action, reading the output |
| [guides/agent-integrators.md](guides/agent-integrators.md) | how-to | transports, the minimal decision loop, prompting agents, pitfalls |
| [guides/library-api.md](guides/library-api.md) | reference | every exported function by module |
| [guides/typesafe.md](guides/typesafe.md) | how-to + measurements | using TypeSafe Jev well: API facts, weak spots and their fixes, injection, versions, checklist |
| [guides/researchers.md](guides/researchers.md) | how-to | running and adding experiments, generators, delegating to MiniMax |
| [TILES.md](TILES.md) | catalogue | T1–T54: reusable patterns, each with evidence |
| [RESEARCH-LOG.md](RESEARCH-LOG.md) | record | every experiment's numbers and interpretation |
| [JOURNAL.md](JOURNAL.md) | record | how the tools were built: decisions, alternatives, mistakes, process lessons P1–P29 |
| [journal/](journal/) | artefacts | prompts sent to MiniMax and its raw outputs, kept for review |
