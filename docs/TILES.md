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
| T28 | Per-file evidence channels (`reads`) | `orchestrator.verifyFiles`, `invalidateChangedFiles` | proven |
| T29 | Cross-sense teaching (sight calibrates smell) | `senses.mjs`, `jev_teach` / `jev_apply_learned` | proven (edge) |
| T30 | Earned discount for learned thresholds | `learnThreshold({floor, minGoForDiscount})` | proven (edge) |
| T31 | Learn the trust direction of code | `experiments/changelog.mjs` | proven |
| T32 | Choice-as-matcher + Noul veto | `experiments/changelog.mjs` | proven |
| T33 | Slice the state, lift the verdicts; convolve counts | `experiments/terraform-scale.mjs` | proven |
| T34 | Margin + fragility on every verdict; stability probe | `evaluateGoNoGo` → `margin`, `fragile`; `stabilityProbe` | proven |
| T35 | Put thresholds in the gaps of the verifier's score distribution | `experiments/fragility.mjs` | proven |
| T36 | Metamorphic acceptance for compiled code | `experiments/metamorphic.mjs` | proven (2 runs) |
| T37 | Noise fails safe; tolerance = the teacher's measured error rate | `learnThreshold({tolerance})` | proven (offline) |
| T38 | A gate rule on a noisy boundary moves the boundary | `require_firm` (opt-in) | negative result |
| T39 | Curated tool surface for agents | `experiments/agent-v2.mjs` | proven (edge) |
| T40 | Automatic Choice-first grouping, validated by Nouls | `grouping.mjs` (was `experiments/choice-grouping.mjs`) | proven, generalised (R5-B) |
| T41 | Scope by consequence, audit the decision delta | `worker/control.mjs`, `LatticeDO.audited` | deployed |
| T42 | Authorisation hooks in the protocol core, refusals as results | `mcp-core.mjs` `handle(msg, ctx)` | deployed |
| T43 | Pin the judge; measure upgrades against the re-ask floor | `JEV_MODEL`, `experiments/model-upgrade.mjs` | proven |
| T44 | Teacher noise → binomial allowance | `senses.mjs` `allowedDisagreements` | proven (offline) |
| T45 | Hand-computed conformance vectors | `conformance/` | shipped |
| T46 | Falsifiable review prompts | `docs/journal/r5-control-plane-review.*` | proven (1 review) |
| T47 | Let the proposer abstain; key by (group, question) | `grouping.mjs` | proven |
| T48 | Regenerate unusable output before judging it | `compiled.mjs` `genRetries`, `extractCode` | proven |
| T49 | Code computes, Jev judges (trusted facts) | `facts.mjs`, `frameEvidence({facts})` | proven (R6) |
| T50 | Describe what the evidence is | `describeFile`, `frameEvidence` | proven (R6) |
| T51 | Remove the attack surface, don't argue with it (strip comments) | `stripComments` (default on) | proven (R6) |
| T52 | Adaptive red team with a reviewer model | `experiments/typesafe-redteam-adaptive.mjs` | method |
| T53 | Evidence-blind lint | `lintGates`, `jev lint` | shipped |

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
- Use `MiniMax-M3.1-Flash-Preview` (the default) for everyday JSON-shaped work and `MiniMax-M3` (`--think`) for big thinking. M2.7-highspeed also spent a whole 12k budget on reasoning for a code-generation task.

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

### T28: Per-file evidence channels
Questions declare `question_spec.reads`. Jev sees only those files, questions with the same read-set share a call, and proofs record per-file hashes. On a 3-file repo with drift this gave 72% fewer Jev questions **and** better accuracy (1.000 vs 0.951 decided-correct). Focused evidence is better evidence.

### T29: Cross-sense teaching
A gate decided by the strongest channel labels the weaker channels' readings on the same evidence. A per question × sense label bank (in the Durable Object) learns thresholds or blocks without ground truth; it matched truth-learned thresholds on 29/29 pairs. Spend freed question budget here (P11). **Limit:** the bank inherits the teacher's blind spots (T31).

### T30: Earned discount
A learned threshold may drop below a floor (e.g. 0.9) only with at least N clean GOs (rule of three: error ≤ ~3/N). This removed the one wrong GO an over-learned bar produced, and kept the recall gains where evidence was plentiful.

### T31: Learn the trust direction of code
A predicate can fail in either direction: Redis parsers over-claim, a "#123 appears" regex under-claims. Measure the precision of YES and of NO separately, from teacher labels, and trust only the precise direction (refute-only or confirm-only). The teacher's abstentions bias these estimates toward easy cases.

### T32: Choice-as-matcher + Noul veto
For "is X mentioned in this document?", ask a Choice over the candidate lines plus "none". Paraphrase matches went from 24/72 (Noul) to 72/72. Put the Choice and a Noul on one gate: the Choice proposes, the Noul vetoes through CONFLICT. That gave 241/245 correct and 0 wrong.

### T33: Slice the state, lift the verdicts, convolve counts
For long structured states, slice them. Combine per-slice verdicts with the quantifier (any/all), **not** by multiplying probabilities: products turn calibration slack into indecision (0.53 vs 0.976 correct at 300 resources). For counts, convolve per-slice Choice distributions: 1.00, where whole-plan counting gave 0.54–0.63.

### T34: Margin and fragility on every verdict
Every gate result carries `margin` (the deciding reading's distance from its bar) and `fragile` (margin < max(`fragility_band`, measured spread)). Re-ask flips concentrate within 0.02 of the bar: 50% there, 7% at 0.02–0.05, 0% beyond at t=0.9. The flag caught every observed flip among decided gates, while flagging only 4.7% of them at 0.9. `stabilityProbe` re-asks outside the cache and stores the spread on the cache entry, so the cache becomes a measurement rather than only a speedup. *Origin:* an independent measurement posted on PR #1 by the gitpp-side agent.

### T35: Put thresholds in the gaps
A verifier's readings cluster (Jev: about 0.95–0.99 for yes, 0.01–0.06 for no). A threshold placed inside a cluster makes many verdicts fragile: at 0.95, 42 of 160 gates were within 0.02 of the bar, against 6 at 0.9. Look at the score histogram and put the bar in a sparse region.

### T36: Metamorphic acceptance for compiled code
Before accepting a predicate, also test it on **meaning-preserving rewrites** of the training inputs. MiniMax writes the rewrites, and Jev confirms each one means the same as its original. In both runs this rejected exactly the brittle predicates: those accepted by plain validation produced 5–8 errors after a format shift, and those accepted metamorphically produced 0. The rewriter was never told what the shift would be.

### T37: Noise fails safe; tolerance = the teacher's measured error rate
The zero-disagreement learning rule turns teacher noise into conservatism (bars blocked, 0 wrong GOs), not danger. To recover liveness, allow a disagreement rate equal to the teacher's **measured** error rate, and no more: any extra tolerance admits the student's own errors.

### T38: A gate rule on a noisy boundary moves the boundary
Holding fragile verdicts OPEN until corroborated made gates *less* reproducible, because fragility itself flips near bar + band. Reproducibility comes from caching the evidence-to-reading map, not from more gate rules. Keep `fragile` as an alert; `require_firm` is opt-in.

### T39: Curated tool surface for agents
With the same agent and prompt, 6 tools instead of 23 meant 33% fewer calls, and the unknowable gate stayed OPEN instead of being "refuted" from absence of evidence (7/8 vs 3/8). Every extra proof source is one more way to manufacture confidence.

### T40: Automatic Choice-first grouping
MiniMax proposes field-level Choice questions with mappings to the existing yes/no questions. Each mapping is accepted only if it agrees with Jev's Nouls on training data. Accepted mappings beat the Nouls on held-out data (Brier 0.0001 vs 0.0056, recall 1.00 vs 0.965) with 0 wrong.

## Round 5 tiles (v0.7)

### T41: Scope by consequence, audit the decision delta
Grant permissions by what a call can *change*: `read` (nothing), `verify` (adds evidence), `admin` (replaces the lattice or its policy). Unknown tools default to the middle scope, never to read. Audit by snapshotting the decisions before and after each mutating call and storing only what moved, with the evidence that moved it. That answers "who moved this gate?" directly; a request log can't. *Where:* `worker/control.mjs`, `LatticeDO.audited`.

### T42: Authorisation hooks in the protocol core, refusals as results
Put `allow(name)` and `guard(name, args)` hooks in the transport-agnostic dispatcher, and return refusals as tool results (`isError`, `forbidden:` / `quota:`) rather than protocol errors. Every transport gets the same enforcement, and agents can read why they were refused. *Where:* `mcp-core.mjs` `handle(msg, ctx)`.

### T43: Pin the judge; measure an upgrade against the re-ask floor
An upgrade's flips mean something only next to the same model's re-ask flips. Jev 1.13.0 → 1.14.0: 2–2.5× the re-ask flip rate and ≈3× the mean |Δp|, with the same accuracy. Pin the model, key caches on it, and treat an upgrade as a migration (re-verify once, review what moved). *Where:* `JEV_MODEL`, `experiments/model-upgrade.mjs`.

### T44: Teacher noise → a binomial allowance, from a point-estimated audit
Forgive the number of disagreements that a teacher with flip rate ε would plausibly produce among m samples (`allowedDisagreements(m, ε)`), not a fixed fraction. Estimate ε from a hand-checked sample of at least 30 labels, using the point estimate (the Wilson upper bound let wrong GOs through even with a perfect teacher). It is safe up to about 5% noise; beyond that, fix the teacher. *Where:* `senses.mjs`.

### T45: Hand-computed conformance vectors
Write the spec's cases as data, with expectations computed from the prose by hand. Never generate them from the implementation. They become a cross-implementation test, and writing them tests the spec itself: this found a false claim about OPEN margins. *Where:* `conformance/gate-vectors.json`.

### T46: Falsifiable review prompts for model reviewers
Ask a reviewer model for a stated threat model, an exploit sequence per finding, and an explicit "not sure". MiniMax-M3's security review went from 21% to 85% real findings, and its one "not sure" was its one false finding. *Where:* `docs/journal/r5-control-plane-review.*`.

### T47: Let the proposer abstain; key derived answers by (group, question)
When a model proposes structure (groups, decompositions), the prompt must allow "nothing here". MiniMax then grouped only same-field questions and left three different redis settings alone. Validate each mapping on its own, and key derived values by (group, question), so that two proposals for one question can't overwrite each other. *Where:* `grouping.mjs`.

### T48: Regenerate unusable model output before judging it
Separate "the output wasn't usable" (no code, a parse or compile error) from "the code was wrong" (disagreed with labels). Regenerate the first cheaply, without spending a validation attempt, and extract code from fences or bare arrows as well as JSON. Usable candidates: 60% → 85–90%. *Where:* `compilePredicate({genRetries})`, `extractCode`.

## Round 6 tiles (v0.8)

### T49: Code computes, Jev judges
Jev reads literally and is weakest at units, last-wins resolution, defaults and counts. Trusted extractors compute those values and add them to the state next to the file. Hard bench: 179 → 198 of 200 correct (Brier 0.0189 → 0.0011); product path: 106 → 117 of 120. **The facts become an authority**: Jev followed a deliberately wrong fact 9 of 60 times and never sided with the file over it. So extractors are tested code, never model-written, and they report "not set" rather than guess.

### T50: Describe the evidence
For the same redis.conf, Brier went from 0.0153 (bare string) to 0.0055 when the state said what the file is. `frameEvidence` adds a description by file type.

### T51: Remove the attack surface, don't argue with it
Framing and criteria against prompt injection held on one model version and broke on the next (2 wrong GOs on 1.14.0 against an adaptive attacker). Deleting semantically void content (full-line comments) with trusted code before the model reads it took wrong GOs from 83–119 of 630 to 0, at no cost in clean accuracy.

### T52: Adaptive red team with a reviewer model
A one-shot attack list badly underestimates risk: 1 wrong GO in 360 where an adaptive attacker got 33. Give the attacker model the defense and its best scores so far, and iterate; keep the payloads truth-preserving (comment-only) so the score is unambiguous.

### T53: Evidence-blind lint
Ask every gate about empty versions of its files. A GO means the gate passes when its evidence is absent. One call per file set; it runs before a gate is trusted.
