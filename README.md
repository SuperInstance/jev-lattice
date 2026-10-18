# JEV Lattice

**Deterministic go/no-go gates for software decisions, backed by calibrated evidence.**

You write a decision as a yes/no **question** with an explicit contract, for example "two independent proofs, each at least 0.9". Evidence arrives as **proofs** from any mix of verifiers:
- [TypeSafe Jev](https://docs.typesafe.ai), a calibrated yes/no model;
- parsers, sensors and compiled code;
- LLMs such as MiniMax or Cloudflare Workers AI.

The gate's verdict (**GO / OPEN / REFUTED / CONFLICT**) is computed by deterministic code, never by a model. It is cached, reproducible and auditable, it reports how close each verdict is to flipping, and it re-checks itself when the evidence changes.

```
 evidence (files, plans, logs) ──▶ verifiers ──▶ proofs ──▶ QUESTION gate ──▶ GO | OPEN | REFUTED | CONFLICT
                                    Jev · code · LLMs        (deterministic)     + margin, fragile
```

It runs in four places with one schema: a **JS library**, an **MCP server** (stdio), a **Cloudflare Worker** (MCP over HTTP, with a Durable Object per lattice) and a **browser UI**.

---

## Contents
1. [Quick start (5 minutes)](#quick-start-5-minutes)
2. [Core concepts](#core-concepts)
3. [How-to guides](#how-to-guides)
4. [Configuration](#configuration)
5. [Testing](#testing)
6. [Troubleshooting](#troubleshooting)
7. [Documentation map (by role)](#documentation-map-by-role)
8. [What we've measured](#what-weve-measured)
9. [Layout](#layout)

---

## Quick start (5 minutes)

**Requirements:** Node ≥ 20. Nothing else for the core. API tokens are needed only for live verifiers.

```bash
git clone https://github.com/SuperInstance/jev-lattice && cd jev-lattice
npm install            # only dev dependency: wrangler (for the Cloudflare deployment)
npm test               # offline test suite, no network or tokens needed
node examples/quickstart.mjs
```

`examples/quickstart.mjs` runs offline, and `tests/examples.test.mjs` checks its output, so this snippet can't go stale:

```js
import { JEVLattice } from "./jev-core.js";

const lattice = new JEVLattice();
const { node } = lattice.ingest({
  text: "Is the cache safe to deploy?",
  question_spec: { evaluation_mode: "COORDINATED", required_independent_proofs: 2, confidence_threshold: 0.9 }
});

lattice.addProof(node.id, { source_type: "DETERMINISTIC_PARSER", provider: "redis-conf", confidence: 0.99 });
lattice.evaluateGoNoGo(node.id).verdict;   // "OPEN"  (1 of 2 paths)

lattice.addProof(node.id, { source_type: "JEV_NOUL", provider: "typesafe", confidence: 0.95 });
lattice.evaluateGoNoGo(node.id);           // { verdict: "GO", reason: "2/2 independent proofs satisfied", margin: 0.05, fragile: false, … }

lattice.invalidateProof(node.id, node.active_proofs[0].proof_id, "redis.conf changed");
lattice.evaluateGoNoGo(node.id).verdict;   // "OPEN"  (that path is gone)
```

**With a real verifier:** set `TYPESAFE_AI_TOKEN` and run `node examples/verify-files.mjs`. It asks Jev about a config file and caches the answer. Changing an *unrelated* file keeps the proof; changing the file the question *reads* retires it. Without a token it runs against a stand-in verifier, so you can still see the flow.

---

## Core concepts

| Concept | What it is |
|---|---|
| **Question** | A node with `question_spec`: `evaluation_mode` (`BINARY` = one proof; `COORDINATED` = *k* independent proofs) and `confidence_threshold` (default 0.85). |
| **Proof** | `{source_type, provider?, confidence, cost_weight, evidence?}`. `confidence` is P(the question is true) according to that verifier. |
| **Path / independence** | Proofs sharing an *independence key* (`independence_key`, otherwise `source_type:provider`, otherwise `source_type`) are one path. A path's **latest** reading counts, not its best, so re-asking a verifier can't cherry-pick a pass. |
| **Verdict** | `GO`: enough paths ≥ threshold. `OPEN`: not enough evidence. `REFUTED`: a path says ≤ 1 − threshold. `CONFLICT`: both at once, which blocks GO by default. |
| **Margin / fragile** | How far the deciding reading sits from its bar. `fragile: true` when the margin is inside the verifier's noise (`fragility_band`, default 0.02, or a measured spread). Fragile verdicts are the ones a re-ask can flip. |
| **Invalidation** | Kill a path when its evidence changes. The proof stays on record for audit, and the gate re-evaluates on what remains. |
| **Evidence channels** | `question_spec.reads: ["redis.conf"]` scopes a question to specific files. Verifiers see only those files and proofs record per-file hashes, so changing a file retires exactly the proofs that read it. |
| **Lattice** | The graph of questions and observations: serialisable JSON (`jev-lattice/v0.3`), portable between all four runtimes. |

The full, normative rules are in [docs/GATE-SEMANTICS.md](docs/GATE-SEMANTICS.md). Read them if you are reimplementing the gate in another language.

**Optional spec fields:**

| field | effect |
|---|---|
| `max_proof_age_ms` | Proofs older than this stop counting. |
| `allowed_sources` | Only these `source_type`s may count. |
| `blocked_sources` | These `source_type`s may never count. |
| `source_thresholds` | Per-source bar, e.g. `{"SMALL_MODEL": 0.99}`. |
| `block_on_conflict` | Default `true`. |
| `reads` | Evidence files the question depends on. |
| `fragility_band` | Minimum margin for a verdict to count as firm. |

---

## How-to guides

### Gate a deploy on config files (library, e.g. in CI)
```js
import fs from "node:fs";
import { JEVLattice } from "./jev-core.js";
import { createJev } from "./providers/jev.mjs";
import { cachedJev, createProofCache } from "./proof-cache.mjs";
import { verifyFiles, invalidateChangedFiles } from "./orchestrator.mjs";

const jev = cachedJev(createJev(), createProofCache());     // TYPESAFE_AI_TOKEN in env
const lattice = new JEVLattice();
for (const [file, q] of [["redis.conf", "Is TLS enabled (a tls-port is configured)?"], ["app.env", "Is DEBUG disabled?"]]) {
  lattice.ingest({ text: q, question_spec: { confidence_threshold: 0.9, reads: [file] } });
}
const files = Object.fromEntries(["redis.conf", "app.env"].map(f => [f, fs.readFileSync(f, "utf8")]));
await invalidateChangedFiles(lattice, { files });           // drift: retire proofs whose files changed
await verifyFiles(lattice, { jev, files });                 // ask only the open gates, one call per read-set
const gates = lattice.listNodes().filter(n => n.node_type === "QUESTION").map(n => lattice.evaluateGoNoGo(n.id));
if (gates.some(g => g.fragile)) console.warn("some verdicts are within the verifier's noise; consider a second path");
process.exit(gates.every(g => g.go) ? 0 : 1);
```
Persist `lattice.exportState()` between runs (as an artifact or a cache) to keep the history of proofs, then `importState` it at the start of the next run.

### Gate CI with one config file (CLI + GitHub Action)
```bash
npx -p jev-lattice jev gate --config jev.gates.json    # exit 0 = all GO, 1 = not all GO (fails closed), 2 = config error
```
```yaml
- uses: SuperInstance/jev-lattice@v0.6
  with: { config: jev.gates.json, typesafe-token: "${{ secrets.TYPESAFE_AI_TOKEN }}" }
```
Proofs for unchanged files are reused between runs, so a run with no changes makes no API calls. Guide: [docs/guides/ci-gates.md](docs/guides/ci-gates.md).

### Give an agent the lattice (MCP over stdio)
Add this to your MCP client config (Claude Code, Cursor, or any MCP host):
```json
{
  "mcpServers": {
    "jev-lattice": {
      "command": "node",
      "args": ["/abs/path/jev-lattice/mcp-server.mjs"],
      "env": { "JEV_STATE_PATH": "/abs/path/state.json", "TYPESAFE_AI_TOKEN": "…", "MINIMAX_TOKEN": "…" }
    }
  }
}
```
The agent gets `jev_ingest`, `jev_verify_files`, `jev_evaluate_go_no_go` and the rest of the tools. Tools for providers you haven't configured are hidden. Recipes and pitfalls are in [docs/guides/agent-integrators.md](docs/guides/agent-integrators.md).

### Run it on Cloudflare (MCP over HTTP + Durable Objects)
```bash
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
npm run deploy
printf %s "$JEV_API_KEY"       | npx wrangler secret put JEV_API_KEY        # required: bearer auth
printf %s "$TYPESAFE_AI_TOKEN" | npx wrangler secret put TYPESAFE_AI_TOKEN
printf %s "$MINIMAX_TOKEN"     | npx wrangler secret put MINIMAX_TOKEN
node scripts/smoke-worker.mjs https://jev-lattice.<you>.workers.dev "$JEV_API_KEY" --live
```
Each lattice name gets its own Durable Object, reachable at `POST /mcp/<name>` and `/api/<name>/…`. The deployment includes:
- the proof cache;
- the drift detector (`PUT /api/<name>/auto-verify`);
- sandboxed compiled predicates (Dynamic Workers);
- cross-sense teaching (Workers AI);
- the browser UI at `/browser/`.

Operations guide: [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

### Watch a config and re-verify on change
```bash
curl -X PUT https://…/api/prod-redis/auto-verify -H "authorization: Bearer $JEV_API_KEY" \
     -H "content-type: application/json" --data @state.json
```
The Durable Object hashes the state, retires proofs built on older content, and re-verifies only the gates that reopened. Reverting to a previous state is served entirely from the cache.

### Use cheaper verifiers safely
- **Compiled predicates** (model-written code): use refute-only or confirm-only, depending on which direction the code is precise in. Never let code alone say GO without measuring that. See `compiled.mjs` and tiles T21 and T31.
- **Small or overconfident models:** give them a higher bar, e.g. `source_thresholds: {"SMALL_MODEL": 0.99}`. Or let the lattice learn per-question bars from gates Jev has already decided, with `jev_teach` and `jev_apply_learned` (tiles T29 and T30).
- **Fragile verdicts:** add an independent second path (COORDINATED), or measure the reader's noise with `stabilityProbe` (proof-cache.mjs) so the margin is judged against a real spread.

---

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `TYPESAFE_AI_TOKEN` | library, MCP, Worker | Jev access (enables `jev_verify*`, `jev_compile`) |
| `MINIMAX_TOKEN` | library, MCP, Worker | MiniMax access (enables `jev_minimax_proof`, `jev_decompose`, paraphrase senses) |
| `JEV_STATE_PATH` | MCP stdio | lattice file (default `./jev-state.json`) |
| `JEV_TIER` | MCP stdio | `minimal` \| `standard` \| `high` (default: probed from RAM/CPU) |
| `JEV_CACHE` / `JEV_CACHE_TTL_MS` | MCP stdio, Worker | proof cache on/off (default on) / lifetime (default 24h) |
| `JEV_NO_PROVIDERS=1` | MCP stdio | hide provider tools (offline, tests) |
| `JEV_API_KEY` | Worker (secret) | bearer key for `/mcp` and `/api`; access is refused when it isn't set |
| `MINIMAX_MODEL` | Worker | default `MiniMax-M3.1-Flash-Preview` (use `MiniMax-M3` for heavy reasoning) |
| `WORKERS_AI_MODEL` | Worker | default `@cf/meta/llama-3.1-8b-instruct-fast` |
| `MINIMAX_TIMEOUT_MS`, `MINIMAX_MAX_TOKENS` | `providers/minimax.mjs` CLI | for long generations; `--think` selects M3 |

---

## Testing

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | gate, regressions, orchestrator, proof cache, compiled predicates, calibration, senses, MCP stdio end-to-end, README examples | nothing |
| `npm run test:browser` | browser UI end-to-end (Playwright) | Chromium |
| `node scripts/smoke-worker.mjs <url> <key> [--live]` | a deployed Worker, end to end | deployed Worker |
| `npm pack --dry-run` | what the npm package ships (product files only) | nothing |
| `npm run live:*` | experiments with real providers ([docs/guides/researchers.md](docs/guides/researchers.md)) | tokens |

CI (`.github/workflows/ci.yml`) runs the tests on Node 20 and 22, the browser end-to-end test, and a Worker bundle check.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| A question is GO with no proofs | It's an OBSERVATION. Pass `question_spec` or `node_type: "QUESTION"`; questions are never implicitly GO. |
| Adding the same proof twice doesn't satisfy COORDINATED | By design: the same independence key is one path. Use a different `provider` only for truly independent paths. |
| A re-asked gate changed verdict | Jev isn't bit-deterministic, and readings within about 0.02 of the threshold can flip. Wrap Jev in `cachedJev`, and look at `fragile`. |
| Many verdicts are `fragile` | The threshold sits in a dense part of the verifier's score distribution (e.g. 0.95 for Jev). Move it into a gap (0.9) or add a second path. |
| A gate stays OPEN on counting or paraphrase questions | Jev abstains rather than err. Slice the state and count (T33), or ask a Choice (T24, T32). |
| Worker returns 401 | The `JEV_API_KEY` secret is missing, or the bearer header is wrong. |
| `jev_edge_proof` fails locally | The Workers AI binding only runs remotely; use a deployed Worker. |
| MiniMax returns empty text | Reasoning used the whole token budget. Raise `MINIMAX_MAX_TOKENS`, and specify algorithms rather than statistical targets in prompts (journal P16). |
| The browser UI won't load from `file://` | ES modules need HTTP. Serve the repo root, or use the Worker's `/browser/`. |

---

## Documentation map (by role)

| You are… | Start here |
|---|---|
| **An engineer adding gates to a pipeline** | [docs/guides/ci-gates.md](docs/guides/ci-gates.md) → [docs/GATE-SEMANTICS.md](docs/GATE-SEMANTICS.md) |
| **Deciding how to deploy or package it** | [docs/PRODUCTION.md](docs/PRODUCTION.md) |
| **Building agents or MCP integrations** | [docs/guides/agent-integrators.md](docs/guides/agent-integrators.md) · [docs/MCP.md](docs/MCP.md) |
| **A JS developer embedding the library** | [docs/guides/library-api.md](docs/guides/library-api.md) |
| **A platform engineer running the Cloudflare deployment** | [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) |
| **A researcher running or adding experiments** | [docs/guides/researchers.md](docs/guides/researchers.md) · [docs/RESEARCH-LOG.md](docs/RESEARCH-LOG.md) |
| **Contributing to the core** | [CONTRIBUTING.md](CONTRIBUTING.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **Designing the next tool** (patterns and process) | [docs/TILES.md](docs/TILES.md) · [docs/JOURNAL.md](docs/JOURNAL.md) |

Full index: [docs/README.md](docs/README.md).

---

## What we've measured

Selected results. Every number has a script in `experiments/` and raw output in `experiments/results/`.

- **Jev as a gate verifier:** 99–99.7% accurate on 600 config questions labelled by code, with **0 wrong GOs**, at about 1 ms per question when batched.
- **Re-ask flips are a near-threshold effect:** 50% flip rate within 0.02 of a 0.9 bar, 7% at 0.02–0.05, 0% beyond. The `fragile` flag caught **every** flip among decided gates.
- **Proof cache:** 66–73% fewer verifier calls, and 0 verdict flips on unchanged evidence (vs 10–47 without it).
- **Per-file evidence:** 72% fewer questions **and** higher accuracy (1.000 vs 0.951).
- **Cross-sense teaching on the edge:** thresholds learned from Jev-decided gates matched truth-learned ones on 29/29 question × sense pairs. With an earned-discount floor, the weaker senses gave 0 wrong GOs.
- **Compiled code:** trusted alone, it produced 5–24 wrong GOs under format drift. In the right trust direction it gave 0 wrong GOs at half the Jev cost.
- **Long states** (300-resource Terraform plans): slicing the state and lifting verdicts reached 0.976 correct, vs 0.53 when multiplying probabilities. Convolving count distributions was perfect.
- **Agents:** a MiniMax agent driving the lattice made 16/16 correct deploy decisions and relayed the verdicts verbatim. An *uninstructed* agent also chose the lattice (8/8), but over-explored the tools.

---

## Layout
```
jev-core.js            gate + lattice (no dependencies; browser, Node, Workers)
gate.mjs               config-driven gating (jev gate / GitHub Action)
bin/jev.mjs            CLI: gate · check-config · mcp · version
orchestrator.mjs       verifiers → proofs: verify, fan-out, per-file, decompose, roll-up, compile, drift
proof-cache.mjs        content-addressed answers (memory / Durable Object storage) + stability probe
compiled.mjs           model-written predicates: compile, validate, schedule, quarantine, heal
senses.mjs             cross-sense teaching: label bank, learned thresholds
calibration.mjs        isotonic maps + reliability metrics (analysis)
mcp-core.mjs           MCP tool definitions + JSON-RPC dispatch (transport-agnostic)
mcp-server.mjs         stdio MCP server
harness.mjs            capacity probe → policy tier
providers/             jev.mjs (TypeSafe) · minimax.mjs (+ CLI) · workers-ai.mjs
worker/                Cloudflare Worker + LatticeDO + sandboxed predicates
browser/               canvas UI + edge sync
examples/              runnable examples (tested)
experiments/           benches, generators, results
tests/                 node:test suites + Playwright e2e
docs/                  guides, semantics, architecture, research log, journal
```

## License
MIT
