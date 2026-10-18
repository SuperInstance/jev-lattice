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
