# Guide: library API (JavaScript)

**Audience:** you are embedding the lattice in a Node service, a CLI, a browser app or a Cloudflare Worker.

All modules are ES modules with no runtime dependencies. They use only `fetch` and WebCrypto, so they run on Node ≥ 20, in browsers and in Workers. The one exception is `mcp-server.mjs` and `harness.mjs`, which use Node built-ins. Import paths are relative to the repo root; `package.json` `exports` maps them to `jev-lattice`, `jev-lattice/orchestrator` and so on.

## jev-core.js: the lattice and the gate
```js
import { JEVLattice, createToolRegistry, SCHEMA } from "jev-lattice";
const L = new JEVLattice();
```

| method | returns | notes |
|---|---|---|
| `ingest({text, tags?, node_type?, question_spec?, proof?, active_proofs?, linkToNearest=true})` | `{ok, node}` | A `question_spec` makes the node a QUESTION. |
| `addProof(id, proof)` | `{ok, node, proof, proofCount}` | Append only; the latest reading per path counts. |
| `invalidateProof(id, proofId, reason?)` | `{ok, node, gate}` | The proof is kept for audit. |
| `evaluateGoNoGo(id, {now?})` | gate result | Deterministic. See [GATE-SEMANTICS.md](../GATE-SEMANTICS.md). |
| `query({text, tags?, topK?, beam?})` | `{path, context, latencyMs}` | Spatial + probabilistic beam over the graph. |
| `consolidate({pruneFloor?, mergeDistance?, stitchRadius?})` | stats | The idle cycle: stitch, merge, prune, tag `seeking_verification`. |
| `exportState()` / `importState(state)` | JSON / `{ok, nodes}` | A deep copy; importing reads schema v0.2 and v0.3. |
| `getNode`, `listNodes`, `boost`, `prune`, `stats` | | |

`createToolRegistry(L)` gives the same operations as plain functions (`ingest`, `addProof`, `invalidateProof`, `evaluateGoNoGo`, …). This is what `window.JEV` exposes in the browser.

Helpers: `normalizeProof`, `normalizeQuestionSpec`, `independenceKey`, `multiProofSalience`.

## providers/: verifiers
```js
import { createJev, noulToProof, choiceToProof, scoreToProof } from "jev-lattice/providers/jev";
const jev = createJev({ apiKey, model: "jev-latest", longContext: false });
await jev.noul(state, "Is TLS enabled?");                 // { p, model, latency_ms }
await jev.nouls(state, [{ key, instructions }, …]);       // one request, many questions
await jev.ask(state, { q1: { type: "choice", instructions, criteria: {…} } });
choiceToProof(answer, ["allowed", "options"]);            // P(answer ∈ allowed) → proof
scoreToProof(answer, minLevel);                           // P(level ≥ minLevel) → proof
```
`createMiniMax({apiKey, model})` returns `{chat, json}`. The default model is `MiniMax-M3.1-Flash-Preview`; `MINIMAX_THINK_MODEL` is `MiniMax-M3`. `createWorkersAI(env.AI)` returns `{chat, json}`, inside a Worker only.

## orchestrator.mjs: verifiers → proofs
Providers append proofs; only the gate decides.

| function | what it does |
|---|---|
| `verifyFiles(L, {jev, files, ids?, rules?})` | Per-file evidence. Each open question sees only the files in its `reads`; one Jev call per read-set; proofs record `evidence.file_hashes`. |
| `invalidateChangedFiles(L, {files})` | Retires proofs whose recorded file hashes changed or whose file was removed. |
| `verifyOpenGates(L, {jev, state, ids?, channel?})` | Every open question against one shared `state`, in a single call. |
| `invalidateStale(L, {state, channel?})` | Retires proofs whose recorded `state_hash` (in `channel`) differs from `state`. |
| `verifyWithJev(L, id, {jev, state?, instructions?, criteria?, channel?})` | One question. `state` defaults to the lattice neighbourhood (`latticeState`). |
| `proveWithLLM(L, id, {llm, state?, source_type?, provider?, cost_weight?})` / `proveWithMiniMax` | An LLM-judgement proof. |
| `decompose(L, id, {mm, maxSub?})` | MiniMax → BINARY child questions. |
| `rollup(L, id)` | Children all GO → a `LATTICE_READ` proof; a REFUTED child → a refuting proof. |
| `compile(L, id, {jev, mm, state?, stopOn?})` | Cheap-first loop: Jev → MiniMax → decompose + fan-out → roll-up. |

## proof-cache.mjs: reproducible, cheap verification
```js
import { cachedJev, createProofCache, memoryStore, durableObjectStore, stabilityProbe } from "jev-lattice/proof-cache";
const cache = createProofCache({ store: memoryStore(), ttlMs: 24 * 3600e3 });
const jev = cachedJev(createJev(), cache);       // same interface; hits are free, misses batched
await stabilityProbe(rawJev, state, items, { n: 5, cache });   // spread per question, saved on cache entries
```
The cache key is `provider | model | sha256(canonical state) | sha256(question + criteria)`. The state is canonicalised (keys sorted) before hashing *and* before sending. In a Worker, use `durableObjectStore(ctx.storage)`.

## compiled.mjs: model-written predicates
| function | purpose |
|---|---|
| `compilePredicate({mm, question, rules, examples, labeled, sandbox, minLabels})` | Write → validate against confident labels → retry with a counterexample. |
| `createPredicateRegistry()` | Holds active / quarantined predicates, counterexamples and the label history. |
| `answerCompiledFirst({registry, items, text, state, jev, spotCheck?, trust?})` | Predicates first, Jev for the rest. `trust: "refute-only"` sends a compiled YES to Jev. |
| `healQuarantined({registry, mm, rules, sandbox, examples})` | Recompile from counterexamples. |

`sandbox(code) → fn` is injected. **`node:vm` is not a security boundary.** In production, use Dynamic Worker isolates (`worker/predicates.mjs`).

## senses.mjs: cross-sense teaching
```js
const suite = createSenseSuite({ jev, mm, small, predicates, store, rules });
await suite.teach(L, { files });          // decided gates label each sense's reading
await suite.report(L, { minSamples: 8, minGo: 3, floor: 0.9, minGoForDiscount: 30 });
await suite.apply(L, { … });              // writes source_thresholds["SENSE:x"] / blocked_sources
await suite.probe(L, { files, addProofs: true });
```
`learnThreshold(samples, opts)` is the core rule: the smallest safe bar, with an earned-discount floor.

## calibration.mjs: analysis helpers
`fitIsotonic(rows)`, `calibrate(map, p)`, `calibrateProof(proof, maps)`, `reliability(rows)` (Brier, ECE, GO/wrong-GO per threshold). The gates themselves prefer `source_thresholds` (tile T22).

## mcp-core.mjs: embed the MCP surface in your own transport
```js
import { createMcp } from "jev-lattice/mcp";
const mcp = createMcp({ lattice: L, jev, mm, small, predicates, senses, persist: async () => save(L.exportState()) });
const response = await mcp.handle(jsonRpcMessage);   // null for notifications
```
Tools appear only for the providers you pass.

## Patterns
- **CI gate:** `importState` (previous run) → `invalidateChangedFiles` → `verifyFiles` → check `.go` / `.fragile` → `exportState`.
- **Long-running service:** one lattice per tenant or project, with `cachedJev` sharing a store.
- **Browser:** `browser/app.js` uses the same core. The edge buttons push, pull and verify against a Worker.
