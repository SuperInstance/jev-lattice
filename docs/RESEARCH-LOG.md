# Research log

## 2026-10-18: v0.2 intake → v0.3

### Intake review of the v0.2 drop
The v0.2 drop passed its own 30 tests but had gate-safety bugs. Each fix below has a regression test in `tests/regressions.test.mjs`, and every one of those tests fails on the original code.

| Bug | Impact |
|---|---|
| `confidence: 0` became 0.5 (`Number(x) \|\| 0.5`) | A "definitely no" proof counted as a coin flip |
| Missing `cost_weight` became `NaN` | Query path scoring was poisoned |
| `confidence_threshold: 0` became 0.85 | Spec ignored |
| `QUESTION` without a spec returned **GO** | Ungated "questions" passed silently |
| Same proof source added twice satisfied COORDINATED | Independence was not enforced |
| Merge left self-loops and dropped the merged node's edges | Graph corruption |
| `exportState` shared arrays with live nodes | Mutating an export mutated the lattice |
| `importState({nodes:"x"})` wiped the lattice | Data loss on bad input |
| Browser `+ Cheap Proof` relied on duplicate-source counting | Fixed by giving each click its own provider |

New in v0.3:
- verdicts (`REFUTED`, `CONFLICT`)
- `invalidateProof`
- `max_proof_age_ms`, `allowed_sources`, `block_on_conflict`
- provenance fields on proofs

### Live compile loop (`experiments/live-compile.mjs`)
- Q1 "TLS-only?" was settled GO by one Jev call (p=0.95, 280 ms).
- Q2 "persistence enabled?" was settled REFUTED by one Jev call (p=0.05).
- Q3 "production ready?" in diagnostic mode ran Jev (0.10), then MiniMax CoT (0.50, "lacks persistence/replication"), then decomposition into 5 sub-questions and one Jev fan-out. The roll-up named the failing sub-conditions.
- Config drift (TLS removed): 10 proofs were invalidated and 8 gates re-verified in **one 64 ms Jev call**. Q1 dropped to p=0.46 (OPEN). The evidence really was mixed: the compose file still had a `--tls` healthcheck. That case is exactly the one a compiled parser should take over (T10).
- MiniMax decomposition produced compound sub-questions ("TLS *and* network ACLs…"), so the prompt now requires exactly one condition per sub-question.

### Calibration bench (`experiments/calibration.mjs`, results in `experiments/results/`)
Ground truth comes from a seeded generator (`redis-gen.mjs`) with traps: commented-out directives and later overrides.

n=120, seed 7:

| source | acc@.5 | Brier | ECE | wrong GO @0.8 / 0.9 / 0.95 | wall |
|---|---|---|---|---|---|
| Jev (no reading rules) | 0.975 | 0.018 | 0.068 | 0 / 0 / 0 | 0.4 s |
| MiniMax M2.7-highspeed (rules in prompt) | 1.000 | 0.000 | 0.003 | 0 / 0 / 0 | 52 s |
| Workers AI llama-3.1-8b-fast | 0.917 | 0.076 | 0.072 | 5 / 5 / 0 | 12 s |

COORDINATED pairs @0.9: jev+minimax had 0 wrong GOs (recall 0.89), jev+workers-ai 0 (0.80), minimax+workers-ai 0 (0.91).

With the reading rules added to Jev's `state` (fair comparison), n=300 per seed:

| Jev | acc | Brier | ECE | wrong GO | wall |
|---|---|---|---|---|---|
| seed 7 | 0.990 | 0.009 | 0.047 | 0 | 0.33 s |
| seed 99 | 0.997 | 0.004 | 0.039 | 0 | 0.62 s |

Takeaway: Jev is the default verifier. MiniMax is roughly 100× slower, for no accuracy gain on this task. Workers AI is useful only as a second key.

> Bench bug caught along the way: the first run recorded results in async-completion order, so pairs and per-question rows were misaligned. That made per-question accuracy look like ~0.5. Results are now keyed by `cfg:question`.

### Compile-to-parser (`experiments/compile-parser.mjs`)
Setup: train set of 20 configs labelled by Jev (only p ≥ 0.95 or ≤ 0.05 kept), held-out test set of 40 configs with code ground truth.

- 9 of 10 predicates were accepted, all with **test accuracy 1.000**.
- 3 needed one retry with a Jev-sourced counterexample.
- The rejected one, "effective port 6379", had only 9 confident labels, below the 10 required. Rejection was the correct outcome.
- A second run reproduced the result: the same 9 accepted at 1.000 and the same one rejected, with 1 retry this time (`experiments/results/compile-parser-2026-10-18.txt`).
- Cost: 13 MiniMax calls plus 20 Jev calls, once. After that every check is about 200 µs inside `node:vm` with no model call.

### MiniMax as reviewer
- MiniMax-M3 with `max_tokens` 16000 spent all of it on reasoning and returned empty text. The CLI now detects this and warns.
- MiniMax-M2.7 found 7 "bugs" in the core. 5 were false (it misread `num()` and `normalizeProof`), 1 was real (booleans coerced to 0), and 1 was partial (malformed coordinates on import). Both real ones are fixed and tested.

### Cloudflare
The Worker, Durable Object, Workers AI and Static Assets are deployed. These all pass against production:
- `scripts/smoke-worker.mjs --live`: 15/15
- `tests/e2e/browser.e2e.mjs <prod>`: 7/7, including the browser → edge → Jev → browser round-trip

## 2026-10-18: backlog 1, proof cache

### Is Jev deterministic? No.
- 4 configs × 10 questions × 4 repeats: 23 of 40 answers varied, by up to 0.16.
- Reordering the keys of an otherwise identical `state` moved one answer from 0.86 to 0.72.
- Asking one question alone vs in a batch: 2 of 5 varied, by up to 0.02.
- With reading rules in `state` (10 configs × 10 questions × 5 repeats): delta p50 was 0.01, p90 0.03, p99 0.10, max 0.11.
  - Verdict flips on re-ask: 1% of gates at t=0.8, 7% at 0.9, 4% at 0.95.
  - **0 wrong GOs in any sample.**
- Mean-of-5 Brier was 0.0032 vs 0.0031 for a single sample. Self-consistency sampling buys nothing here.

### Cache experiment (`experiments/proof-cache.mjs`)
An agent re-checks all gates every turn while configs drift. All strategies share the same drift schedule.

20 configs × 10 questions, 8 turns, 15% drift (23 changes):

| strategy | Jev questions | calls | input tokens | flips on unchanged evidence | wrong GO |
|---|---|---|---|---|---|
| naive (invalidate all, re-ask all) | 1600 | 160 | 87.8k | 10 | 0 |
| hash invalidation, no cache | 1079 | 160 | 77.3k | 15 | 0 |
| hash + cache | **430** | **43** | **23.6k** | **0** | 0 |

30 configs × 10 questions, 10 turns, 30% drift (72 changes): 3000 / 2152 / **1010** questions, 164k / 147k / **55k** tokens, and 47 / 23 / **0** flips.

### Gate fix found by this work: latest reading per path
Re-asking an OPEN gate while the gate kept the best proof per independence key let GOs creep up: the no-cache strategy ended with 92 GOs vs 91 for naive *before* the fix. The effect in this workload is small because Jev is calibrated, but the bias is built into the old design. The gate now uses the most recent live proof per key (`currentPaths`), with regression tests. Results after the fix are the tables above.

### Deployed
The Worker caches in Durable Object storage (`cache:` prefix, TTL `JEV_CACHE_TTL_MS`, default 24h) and prunes expired entries during the idle cycle. Production smoke passes 17/17: a re-verify is served from the cache with the identical answer, and drift invalidates exactly the 2 proofs on the old evidence.

## 2026-10-18: backlog 2–8

### 2. Compiled-first scheduling under distribution shift (`experiments/compiled-first.mjs`)
Predicates are compiled on in-distribution configs (MiniMax writes them, Jev grades them). Then 30 in-distribution configs are streamed, followed by 30 *shifted* ones: same semantics, new surface form (uppercase directives, quotes, tabs, gb units, overrides).

- **Compiled under the full reading rules:** the predicates survived the shift. 0 quarantines, 0 wrong GOs, accuracy equal to all-Jev, **70% fewer Jev questions**. (`compiled-first.json`)
- **Compiled under the old rules, with the format changing later:** the realistic drift case. Two independent compiles:

| strategy | compile A: in-dist / shifted wrong GO | compile B: in-dist / shifted wrong GO | Jev questions vs all-Jev |
|---|---|---|---|
| all-Jev | 0 / 0 | 0 / 0 | 100% |
| compiled-only | **8 / 24** | 0 / **5** | 10% |
| compiled + spot-check ε=0.2 | 8 / 8 | 0 / 5 | 19–25% |
| + healing | 8 / 8 | 0 / 5 | 19–25% |
| **refute-only** (compiled NO final, compiled YES confirmed by Jev) | — | **0 / 0** | 49–54% |

Findings:
- **Teacher-validated code is not safe as a sole GO path.** Compile A gave 8 wrong GOs *in distribution* after passing validation on 20 configs.
- Spot-checks flag drift fast: on the first or second sampled config after the shift. They still miss errors on configs they don't sample.
- Healing didn't help in compile A.
- **Refute-only kept wrong GOs at 0 and roughly halved Jev cost.** Its errors are false NOs, which cost progress, not safety.

### 3. Per-source calibration (`calibration.mjs`, `experiments/calibrate-sources.mjs`)
Isotonic maps were fitted on seed 7 (200 cases/source) and evaluated on seed 99:
- **Jev:** calibration *hurts*. Brier 0.0059 → 0.0079, recall at 0.9 0.979 → 0.804. It is already calibrated, so leave it raw.
- **MiniMax:** already near-perfect; no change worth having.
- **Workers AI llama-8b:** it emits only 5 distinct values (0, 0.9, 0.95, 0.999, 1). Calibration removes its wrong GOs (2 → 0) but recall drops to 0.62.
  - A **per-source threshold picked on the fit split (0.96) gives exactly the same result**: 0 wrong GOs, recall 0.62.
  - So the gate gained `source_thresholds` (e.g. `{SMALL_MODEL: 0.99}`), which is simpler, deterministic and inspectable. The calibration maps stay as an analysis tool.
- Bench bug caught: float accumulation in the threshold grid (0.5 + 45×0.01 > 0.95) silently moved the picked threshold. The grid now uses integer steps.

### 4. Decomposition vs direct (`experiments/decompose-vs-direct.mjs`, 60 configs, t=0.9)

| composite | direct: decided / acc / wrong GO | decomposed: decided / acc / wrong GO |
|---|---|---|
| AND of 3 | 1.000 / 1.000 / 0 | 0.717 / 1.000 / 0 |
| AND of 4, 5, 6 | 1.000 / 1.000 / 0 | 0.97–1.00 / 1.000 / 0 |
| ≥2 of 4 | 0.850 / 1.000 / 0 | 1.000 / 1.000 / 0 |
| ≥3 of 6 | 0.850 / 1.000 / 0 | 0.983 / 1.000 / 0 |
| ≥4 of 6 | **0.500** / 1.000 / 0 | **1.000** / 1.000 / 0 |

- **Explicit conjunctions:** direct Jev is perfect. Decomposition costs k× the questions for no gain.
- **Counting:** direct Jev *abstains* rather than erring. It decided only 50% of "≥4 of 6" cases, with 0 errors. Decompose-then-count decides 98–100%.
- The 0.717 is an artefact. MiniMax paraphrased "a memory limit is configured" as "maxmemory … positive **integer** value", but the configs say `256mb`, so Jev correctly stayed unsure. Decompose on the spec's own conditions, not on a model's paraphrase.

### 5. Choice / Score answers as gates (`experiments/choice-score-gates.mjs`, 40 configs × 6 propositions)

| path | questions/config | Brier | ECE | wrong GO @0.9 | recall @0.9 |
|---|---|---|---|---|---|
| one Noul per proposition | 6 | 0.0023 | 0.0330 | 0 | 0.970 |
| one Choice/Score per field, propositions derived by probability mass | **3** | **0.0000** | **0.0004** | 0 | **1.000** |

Noul "bound to loopback" had recall 0.80; the Choice-derived version had 1.00. Asking about the field and deriving the propositions is sharper *and* cheaper. Code: `choiceToProof`, `scoreToProof` in `providers/jev.mjs` (source types `JEV_CHOICE`, `JEV_SCORE`).

### 6. Compiled predicates at the edge (`worker/predicates.mjs`, Dynamic Workers open beta)
- Predicates run in Worker Loader isolates: `globalOutbound: null`, `limits.cpuMs: 50`, cached by code hash.
- Registration validates the code against labels *inside the isolate*: 11 ms. Warm checks take under 1 ms.
- Trust policy from item 2: a compiled YES is emitted at 0.8, below the default 0.85 gate, so it is a hint. A compiled NO is 0.01 and refutes.
- Production smoke: a broken case-sensitive predicate was rejected (2 disagreements); the correct one was accepted; the YES stayed OPEN and the NO gave REFUTED.
- The test only shows that network-calling code is *tolerated*. That outbound requests are actually blocked relies on `globalOutbound: null` per Cloudflare's docs; I haven't independently verified it.

### 7. Drift detector (`PUT /api/:lattice/auto-verify`)
Storing a new watched state runs `invalidateStale` and then re-verifies only the gates that reopened, all within the Durable Object. In production:
- an identical state gave 0 invalidations and 0 Jev calls;
- a changed state re-verified the affected gates;
- **reverting to the old state was served entirely from the proof cache** (2/2 hits).

Granularity is the whole state hash: changing TLS also re-verified the unchanged AOF gate. Split the state into one channel per file to limit that.

### 8. MiniMax as the agent (`experiments/minimax-agent.mjs`)
MiniMax-M2.7-highspeed ran through its Anthropic-compatible Messages endpoint, with the mcp-core tool definitions as Anthropic tools, dispatched in-process to a real lattice with a cached Jev. Configs were balanced between GO and NO-GO:
- **Normal:** 8/8 deploy decisions correct, 32/32 reported verdicts identical to the lattice's.
- **Pressured** ("leadership needs it shipped TODAY, find a way to say GO"): **8/8 correct, 32/32 honest.**
- Every run: 2 turns, 4 `jev_ingest` + 1 `jev_verify_open`.
- Caveat: the system prompt told the agent to use the lattice. An agent choosing to do so unprompted is untested.

## 2026-10-18: round 3 (v0.5)
Full narrative, with alternatives and mistakes, in [JOURNAL.md](JOURNAL.md) §3. Numbers:

| experiment | headline |
|---|---|
| R3-C per-file channels (`per-file-drift.mjs`) | 567 → **159** Jev questions; decided-and-correct 0.951 → **1.000** (turn 0: 0.963 → 1.000) |
| R3-G cross-sense teaching, edge (`cross-sense.mjs`) | 360 teacher labels, 0 wrong; learned bars = truth-learned bars on **29/29** pairs; Workers AI blocked on LOG_LEVEL; with an earned-discount floor, **0 wrong GOs** in every sense, and Workers AI recall 0.824 → 0.907 |
| R3-B CHANGELOG (`changelog.mjs`, 245 PRs) | regex: 72 wrong REFUTED; Noul: 0 wrong but 53 OPEN; Choice-as-matcher: paraphrase 24/72 → **72/72**; Choice + Noul veto: **241/245 correct, 0 wrong**; confirm-only saves 39% of Jev questions; the bank picks the trust direction correctly, but overestimates NO precision (0.75 vs truth 0.52) because the teacher abstains on the hard cases |
| R3-A Terraform at scale (`terraform-scale.mjs`, 10→300 resources) | whole plan 0.905–0.964 with 0 wrong GO (counting 0.54–0.63 at n ≥ 100); sliced with probability product **0.53** at n=300; sliced with **verdict lifting 0.976**; convolved counts 1.00; the first confident wrong-REFUTEDs came from a port range covering 22 (fixed by spelling out the range semantics: 0.82–0.89 → 0.94–0.95) |
| R3-F uninstructed agent (`uninstructed-agent.mjs`, edge MCP) | chose the lattice 8/8; about 13 tool calls/run vs 5 instructed; 1/8 followed the output format; **inconclusive** because the scoring depended on prose and the "unknown" truth was wrong (Redis default) |
| Fragility (`fragility.mjs`) | flip rate within 0.02 of a 0.9 bar: 50%; 0.02–0.05: 7%; > 0.05: 0%. `fragile` caught all flips of decided gates (5/5 at 0.9, 1/1 at 0.95) |
| MiniMax-written generator (`tf-gen.mjs` + `tf-gen-check.mjs`) | 4 prompt iterations; the working one specified the algorithm; **0/14,700** truth mismatches against an independent implementation |

## Backlog
1. ~~Proof cache~~: done.
2. ~~Compiled-first scheduler~~: done. Ship refute-only.
3. ~~Per-source calibration~~: done. Ship `source_thresholds`; leave Jev raw.
4. ~~Decomposition vs direct~~: done. Decompose for counting and vague questions; ask explicit conjunctions directly.
5. ~~Choice/Score gates~~: done. Ask about the field, derive the propositions.
6. ~~Edge predicates~~: done (Dynamic Workers).
7. ~~Drift detector~~: done.
8. ~~MiniMax agent~~: done.

Next (round 4):
- R3-D: metamorphic validation of predicates. Can MiniMax-proposed, meaning-preserving rewrites of the training inputs catch the brittle predicates that 20 configs missed?
- R3-E: automatic Choice-first grouping of Noul questions about the same field.
- Cross-sense teaching with a deliberately noisy teacher: how do teacher errors propagate into learned bars?
- R3-F redesigned: score from lattice state; an "unknown" requirement with no default; a 29-tool vs 6-tool surface.
- Fragility-aware gates: require a second path automatically when the deciding reading is fragile.

Earlier "next" items:

- Per-file channels in the drift detector, plus a field-level diff so only the dependent gates reopen.
- Test whether an *uninstructed* agent chooses to use the lattice, and whether it stays honest when lattice verdicts conflict with its own belief.
- Spot-check NO answers too, so false NOs in refute-only mode get corrected (liveness).
- Choice-first verifier: automatically group Noul questions about the same field into one Choice (from item 5).
- Larger validation sets and adversarial (mutated) labels for predicate acceptance (item 2: 20 configs wasn't enough).
