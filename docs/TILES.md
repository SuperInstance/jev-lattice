# Tiles

Small, reusable patterns that came out of the R&D. Each tile lists what it does, where it lives in the code, and the evidence that it works. Tiles compose; most of the system is a few tiles wired together.

| # | Tile | Where | Status |
|---|---|---|---|
| T1 | Calibrated probability = proof confidence | `providers/jev.mjs` `noulToProof` | proven |
| T2 | Speculative fan-out gate check | `orchestrator.verifyOpenGates`, `jev_verify_open` | proven |
| T3 | Reading rules in `state` | `experiments/calibration.mjs` `RULES` | proven |
| T4 | Lattice-as-state | `orchestrator.latticeState` | working |
| T5 | Independence keys | `jev-core.js` `independenceKey` | proven (tests) |
| T6 | Refutation is a verdict | `evaluateGoNoGo` → `REFUTED` / `CONFLICT` | proven (tests, live) |
| T7 | Path invalidation on drift | `invalidateProof` + one fan-out re-verify | proven (live) |
| T8 | Cheap-first compile loop with `stopOn` | `orchestrator.compile` | working |
| T9 | Diagnostic decomposition | `compile(…, { stopOn: ["GO"] })` + `rollup` | working |
| T10 | Teacher-graded code compilation | `experiments/compile-parser.mjs` | proven |
| T11 | COORDINATED pairing neutralises an overconfident source | calibration bench pairs | proven |
| T12 | Durable Object per lattice, alarm as idle cycle | `worker/index.mjs` | deployed |
| T13 | One MCP core, many transports | `mcp-core.mjs` | deployed |
| T14 | Provider-gated tool surface | `toolDefs({hasJev,…})` | deployed |
| T15 | MiniMax as bulk worker, never as judge of record | `providers/minimax.mjs` CLI | lesson |
| T16 | Content-addressed proof cache | `proof-cache.mjs` `cachedJev` | proven (live, deployed) |
| T17 | Canonicalize state before hashing *and* sending | `proof-cache.mjs` `canonicalize` | proven |
| T18 | Drift invalidation by state hash + channel | `orchestrator.invalidateStale`, `jev_invalidate_stale` | proven (live, deployed) |
| T19 | Latest reading per path (no cherry-picking) | `jev-core.js` `currentPaths` | proven (tests) |
| T20 | OPEN on unchanged evidence needs a different verifier, not a re-ask | cache semantics | lesson |
| T21 | Refute-only trust for compiled code | `compiled.mjs` `trust: "refute-only"`, `worker/predicates.mjs` | proven (live) |
| T22 | Per-source thresholds instead of calibration maps | `question_spec.source_thresholds` | proven |
| T23 | Decompose to count, not to conjoin | `experiments/decompose-vs-direct.mjs` | proven |
| T24 | Ask the field, derive the propositions (Choice/Score → proof) | `choiceToProof`, `scoreToProof` | proven |
| T25 | Sandboxed predicates in Dynamic Worker isolates | `worker/predicates.mjs` | deployed |
| T26 | Watched state = drift detector | `PUT /api/:lattice/auto-verify` | deployed |
| T27 | Cheap agent + lattice = honest gatekeeper | `experiments/minimax-agent.mjs` | proven (live) |

---

### T1: Calibrated probability = proof confidence
Jev's Noul answer is a calibrated P(yes). Store it unchanged as `confidence`, with `source_type: JEV_NOUL` and `cost_weight: 0.05`. No mapping layer is needed, and the deterministic gate does the thresholding.
*Evidence:* across 600 cases, ECE was 0.039–0.047 and there were 0 wrong GOs at ≥0.8.

### T2: Speculative fan-out gate check
Collect every open gate and send them to Jev in **one** request against one shared `state`. Each question key is the node id. Cost grows with the size of the state, not with the number of questions.
*Evidence:* 300 questions in 30 calls took 0.3–0.6 s total. After a config drift, 8 gates re-verified in one 64 ms call.

### T3: Reading rules in `state`
Domain reading rules ("later directives override earlier ones; `#` lines are comments") go *in the state*, next to the data, not in each question.
*Evidence:* without the rules, Jev got 0.83 on effective-port questions; with them it got 1.00. Overall accuracy went from 0.975 to 0.990–0.997.

### T4: Lattice-as-state
When no explicit `state` is passed, the verifier reads the lattice itself: nearby observations plus `VERIFIED:` facts from closed neighbouring questions. Knowledge closed once becomes context for the next question.

### T5: Independence keys
Duplicate paths should not compound. The key is `independence_key`, falling back to `source_type:provider`, then `source_type`. Two proofs from the same parser count once, and the same model behind two prompts can be grouped explicitly.

### T6: Refutation is a verdict
"Not proven" (`OPEN`) and "proven false" (`REFUTED`) need different handling. A scheduler should keep seeking proof for OPEN gates, while a REFUTED gate needs a fix. `CONFLICT` (strong yes *and* strong no) blocks GO by default.

### T7: Path invalidation on drift
When the evidence behind a proof changes, invalidate that proof (it stays on record for audit). Gates fall back to the surviving paths. A single fan-out (T2) then re-verifies everything that reopened.

### T8: Cheap-first compile loop with `stopOn`
The order is Jev, then MiniMax CoT, then decompose plus fan-out, then roll-up. The loop stops at the first decided verdict. In the live run, 2 of 3 questions were settled by the first ~100 ms Jev call and MiniMax was never invoked.

### T9: Diagnostic decomposition
`stopOn: ["GO"]` keeps digging after a refutation. MiniMax splits the question into atomic sub-questions, Jev checks them all in one call, and the roll-up names the failing sub-conditions. The answer to "why NO-GO?" then lives in the lattice, not in a chat log.

### T10: Teacher-graded code compilation
1. MiniMax writes `(text) => boolean`.
2. Run it on a train set and keep only **confident** Jev labels (p ≥ 0.95 or ≤ 0.05).
3. Any disagreement goes back to MiniMax as a counterexample, for one retry.
4. Accept only with zero disagreements and enough confident labels.

Accepted predicates become `DETERMINISTIC_PARSER` proofs at about 200 µs each, with no model call. *Evidence:* 9 of 10 accepted and all 9 scored 100% on held-out ground truth. 3 needed the counterexample retry. The 10th was correctly rejected for too few confident labels. No human labels were used.

### T11: COORDINATED pairing neutralises an overconfident source
On its own, Workers AI llama-8b at 0.9 gave 5 wrong GOs in 54. Paired COORDINATED (k=2) with any other source, it gave 0 wrong GOs, with recall of 0.80–0.91. Use cheap, overconfident sources only as the *second* key.

### T12: Durable Object per lattice, alarm as idle cycle
`idFromName(lattice)` gives each lattice a single-threaded, strongly consistent home. Nodes are stored under per-node keys and only changed nodes are rewritten. Every write pushes the alarm out to 10 minutes, so consolidation runs once the lattice goes quiet ("sleep"). If an `auto-verify` state is set, the alarm also re-verifies open gates with Jev.

### T13: One MCP core, many transports
`mcp-core.mjs` has no Node built-ins. The stdio server, the Worker (`POST /mcp/:lattice`, Streamable HTTP with JSON responses), and in-process tests all share one dispatcher. Tool failures come back as `isError: true` with `structuredContent`.

### T14: Provider-gated tool surface
Tools appear only when their provider is configured: no token, no `jev_verify`. Agents never see tools that would fail, and offline tests run with `JEV_NO_PROVIDERS=1`.

### T15: MiniMax as bulk worker, never as judge of record
MiniMax (on the max plan) is the high-volume worker: decomposition, writing predicates, review passes, brainstorming. Its output always goes through a gate (T10), a test, or human verification before it counts.
*Evidence:* in a code review it reported 7 bugs; 1.5 were real. Operational notes:
- MiniMax-M3 can spend its whole `max_tokens` budget on reasoning and return empty text. The CLI detects this.
- Use `MiniMax-M2.7-highspeed` for JSON-shaped work.

### T16: Content-addressed proof cache
The cache key is `provider | model | hash(canonical state) | hash(question + criteria)`. Misses go to Jev in one batched call, hits cost nothing, and the stores are interchangeable (memory, or Durable Object storage). Two benefits:
- **Cost.** On an agent re-checking 200–300 gates over 8–10 turns with drift, it sent **66–73% fewer Jev questions and tokens**.
- **Reproducibility.** Jev is not bit-deterministic: 23 of 40 repeated answers varied, p99 delta 0.10, and 7% of gates flip GO↔OPEN at t=0.9 on re-ask. With the cache, gates on unchanged evidence had **0 verdict flips**, against 10–47 without it.

A TTL bounds how long a model alias's (`jev-latest`) old answers are served. The Worker prunes expired entries during the idle cycle.

### T17: Canonicalize state before hashing *and* sending
Object key order changes Jev's answer: the same content gave 0.86 vs 0.72. Sort keys, hash the canonical bytes, and send those same bytes, so the cache key and the model input can never diverge.

### T18: Drift invalidation by state hash + channel
Every Jev proof records `evidence.state_hash` and `evidence.channel` (the name of the evidence source, e.g. a file path). When a channel's content changes, `invalidateStale` retires only the proofs built on the old hash. Gates on other channels keep their proofs, and returning to identical old content is served from the cache. Compared with T7's "invalidate by source type", this re-opens far less.

### T19: Latest reading per path
Proofs that share an independence key form one path, and the path's *current* reading is its most recently appended live proof. Before v0.3.1 the gate kept the **max**. That let a caller re-ask a non-deterministic verifier until it said yes, which is cherry-picking by construction. Independent paths still compound, and a re-read can now also clear an old refutation of its own.

### T20: OPEN on unchanged evidence needs a different verifier, not a re-ask
With T16 plus T19, re-asking Jev about an OPEN gate on the same evidence returns the same answer, deliberately. To move the gate, change the evidence or add an *independent* path (MiniMax CoT, a compiled parser, a sensor). The cache turns "ask again" from a lottery into a no-op.

### T21: Refute-only trust for compiled code
Model-written predicates can say **no** on their own; a **yes** must be confirmed by Jev. Teacher validation on 20 configs still let through predicates that gave wrong GOs: 8 in distribution and up to 24 after a format shift. Refute-only kept wrong GOs at 0 and halved Jev cost. At the edge this is the 0.8 YES confidence.

### T22: Per-source thresholds instead of calibration maps
A source that emits a handful of discrete values (Workers AI llama: 0, 0.9, 0.95, 0.999, 1) is best handled by raising *its* bar, `source_thresholds: {SMALL_MODEL: 0.99}`. Isotonic calibration did exactly the same on held-out data, at the cost of opaque maps. Don't calibrate a source that is already calibrated: it made Jev worse.

### T23: Decompose to count, not to conjoin
Jev answers explicit ANDs of up to 6 conditions perfectly in one question. On "at least m of k" it abstains (50% decided for ≥4 of 6) without erring. Decomposing and counting deterministically decides 98–100%. Use the spec's own conditions for the split: a model's paraphrase can add constraints that were never there.

### T24: Ask the field, derive the propositions
One Choice ("which bind address?") or Score ("how much memory?") answers several yes/no gates by probability mass: P(prop) = Σ P(allowed options) or Σ P(levels ≥ L). Compared with one Noul per proposition this halved the questions, cut ECE from 0.033 to 0.0004, and raised recall at 0.9 from 0.97 to 1.00.

### T25: Sandboxed predicates in Dynamic Worker isolates
`env.LOADER.get(hash, …)` with `globalOutbound: null` and `limits.cpuMs`. Acceptance (labels) runs inside the same isolate the code will run in. Warm checks take under 1 ms.

### T26: Watched state = drift detector
PUT the current config to `/api/:lattice/auto-verify`. The Durable Object hashes it, retires proofs built on old content, and re-verifies the reopened gates through the cache, so a revert costs nothing. Use one channel per file to keep the blast radius small.

### T27: Cheap agent + lattice = honest gatekeeper
A MiniMax agent given the MCP tool definitions, told to verify through the lattice and report verbatim, got 16/16 deploy decisions right. Its 64/64 reported verdicts matched the lattice, including under explicit pressure to say GO. The deterministic gate is what makes the agent's report checkable.
