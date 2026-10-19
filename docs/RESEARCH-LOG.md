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

## 2026-10-18: round 4 (v0.6)

| experiment | headline |
|---|---|
| R4-D metamorphic validation (`metamorphic.mjs`, 2 compiles) | The same candidate predicates were put through two acceptance tests. **Plain** (originals) accepted 6 / 4, and they failed after the format shift: 5 wrong GO + 6 wrong NO in run 0, 0 + 8 in run 1. **Metamorphic** (originals plus MiniMax rewrites that preserve meaning, kept only if Jev agrees with the original) accepted 2 / 2, with **0 errors in both runs**. MiniMax was never told what the shift looks like. Only 6 and 4 of 10 candidates compiled at all (Flash output reliability). |
| R4-C noisy teacher (`noisy-teacher.mjs`, offline on calibration rows) | Label noise **fails safe**: 0 wrong GOs at 2–20% flips, because one mislabelled "no" blocks a bar. The cost is liveness: MiniMax recall fell 1.00 → 0.38 at just 2% noise. A `tolerance` matched to the noise recovers recall (2% noise + 3–6% tolerance → 0.90–1.00) with 0 wrong GOs. Real Jev as the teacher made 0 label errors and learned the oracle's bars, so its tolerance should be about 0: tolerance can't tell teacher noise from student error. |
| R4-A fragility-aware gates (`firm-gates.mjs`) | **Negative result.** `require_firm` + an independent MiniMax second path made gates *less* reproducible (0.981 → 0.944 at t=0.95; 0.988 → 0.975 at 0.9), decided fewer, and cost 53 extra calls. Whether a gate is fragile is itself a noisy boundary, so the rule moves the flip band rather than removing it. Reproducibility comes from the cache. `require_firm` stays opt-in and `fragile` stays an alert. |
| R4-E agent, redesigned (`agent-v2.mjs`, edge MCP, scored from lattice state) | Full vs curated tool surface, neutral prompt, 8 runs each, half of them "tempting" (both decidable requirements met). Both arms: **16/16 correct decisions, 0 overclaimed GO**, unknowable gate never GO. Curated: **33% fewer tool calls** (9.5 vs 14.1), and the unknowable gate stayed OPEN in 7/8 runs vs 3/8 on the full surface. With more proof sources available, the agent manufactured confident "no"s from absence of evidence. |
| R4-B Choice-first grouping (`choice-grouping.mjs`) | MiniMax proposed 7 field-level Choice groups; Jev-Noul validation accepted 9/10 mappings. Held-out: derived Brier **0.0001** vs 0.0056, ECE 0.0015 vs 0.0374, recall @0.9 **1.000** vs 0.965, 0 wrong. The largest gains were on bind-address questions (Noul recall 0.73–0.87 → 1.00). Questions per config: 10 → 8. |

## 2026-10-18: round 5 (v0.7)
Narrative in [JOURNAL.md](JOURNAL.md) §5.

| experiment | headline |
|---|---|
| R5-A compile reliability (`compile-reliability.mjs`, 2 runs × 3 arms × 10 questions) | **Regenerating unusable output** (fence/arrow extraction + up to 2 retries) raised usable code from **6/10 to 8–9/10**. Wrong GOs after the format shift: v0.6 acceptance **0 / 5**, regeneration alone **2 / 0**, regeneration + metamorphic **0 / 0** (metamorphic now has 0 wrong GOs in 4 of 4 runs across R4-D and R5-A). **New finding:** every arm produced many wrong **NOs** after the shift (15–45 of 180–270 answers); metamorphic rewrites did not prevent them (32 / 37). Under refute-only trust a wrong NO is a wrong REFUTED: it fails closed, but blocks good deploys until a spot-check or quarantine catches it. Cost: 168 MiniMax calls, 1.08M completion tokens (Flash reasoning). |
| R5-B grouping generalisation (`grouping-repo.mjs`, redis/nginx/env, 13 questions) | Auto-trigger (≥ 3 questions per file) fired on all 3 files. MiniMax proposed **no** groups for the 3 redis questions (three different settings, which is correct) and grouped only same-field questions in nginx (listener) and app.env (DEBUG, LOG_LEVEL); gzip, HSTS and SENTRY_DSN stayed Nouls. Validation accepted **7/7** proposed mappings. Held-out 40 repos: derived Brier **0** vs 0.0008, recall@0.9 **1.000** vs 0.978, 0 wrong GOs; questions asked **520 → 360 (−31%)**. The largest gain was the negated question "listens only on port 80?" (Noul recall 0.824 → 1.000). |
| R5-C automatic tolerance (`auto-tolerance.mjs`, offline, 20 seeds) | `learnThreshold({teacherErrorRate: ε})` forgives the disagreements a teacher with flip rate ε would plausibly produce (binomial 95%). With ε known: **0 wrong GOs up to 5% noise and higher recall than every fixed tolerance** (2% noise, MiniMax: 1.00 vs strict 0.38; 5%: 1.00 vs best fixed 0.89). At 10–20% noise the weaker student (Workers AI) gets 0.7–1.1 wrong GOs: the allowance starts forgiving the student's own errors. ε from a 30-label audit (point estimate) is close to ε known; the Wilson **upper bound** is too loose (2 wrong GOs even with a perfect teacher). Real Jev audits at ε = 0, which keeps the strict rule. |
| R5-D curated tool profiles (shipped, no new experiment) | `gatekeeper` (6 tools) and `reader` profiles on stdio (`JEV_PROFILE`) and HTTP (per key or per lattice). Live smoke: a gatekeeper key lists exactly the 6 tools; other calls return `forbidden: … not in the "gatekeeper" tool profile`. The basis is R4-E. |
| R5-E model upgrade (`model-upgrade.mjs`, jev-1.13.0 ×2 vs jev-1.14.0, 300 + 600 cases) | Re-ask flips **3.0% / 2.5%**; upgrade flips **4.7% / 6.2%** (2–2.5×). Mean \|Δp\| 0.0058 / 0.0047 re-ask vs **0.0158 / 0.0159** upgrade (≈3×), and upgrade flips are less concentrated near the bar (3/14 and 21/37 within 0.02 vs 6/9 and 10/15 for re-asks). Accuracy is unchanged (decided-correct 529–532 / 600 for both models) and there are 0 wrong GOs for either. Most flips are OPEN↔REFUTED. **Pinning protects reproducibility, not safety, on this bench.** |
| Gate conformance vectors (`conformance/`) | 27 hand-computed cases all matched the reference implementation. Writing them found a **spec error**: GATE-SEMANTICS said an OPEN margin is always ≤ 0, but a COORDINATED gate short of `required` has a positive margin (0.14 in the vector). The spec was fixed. |
| Bug found while productising grouping | In R4-B's experiment code, derived answers were keyed by question only, so if two groups mapped the same question the later one silently overwrote the earlier. `grouping.mjs` keys them by (group, question) and has a regression test. R4-B's saved groups map each question exactly once (checked), so its numbers stand; the script now keeps the first mapping instead of the last. |

## 2026-10-18: round 6 (v0.8): learning TypeSafe Jev
The guide distilled from this round: [guides/typesafe.md](guides/typesafe.md). Web research covered TypeSafe's docs index and about 10 public third-party evaluations.

| experiment | headline |
|---|---|
| API probes | Score `criteria` is a **list**; Noul `criteria` is `{true, false}`; the schema is strict at the top level; `jev-preview` serves 1.14.0; 800 questions in one call took 253 ms; 60 concurrent calls all succeeded; the context limit is 32k tokens per question (262k with the long-context header, where 512 KB worked with the needle found); gzip is accepted (81 KB → 4 KB). |
| `typesafe-lab.mjs` (300 questions) | Framing: Brier 0.0153 for a bare string → **0.0055** when the content is described. Batching vs alone vs 30 distractors: \|Δp\| 0.0034 (no interference). Negated questions: the only wrong GOs (2). Naive injection: 1 wrong GO, mostly pushed to OPEN. |
| `typesafe-hard.mjs` / `hard-gen.mjs` (8 families) | Jev **fails safe**: of 800 answers, only 1–2 wrong GOs. Units are the weakest family (15–17 of 25 decided). Reading rules fix overrides (11 → 21–25) and defaults (12 → 25). |
| `typesafe-levers.mjs` (200 cases; 400 on 1.14) | Out of 200: plain 179, criteria 182, structured instructions 185, **code facts 198** (Brier 0.0189 → 0.0011), three-way Choice 191 with 1 wrong GO. On 1.14 with 400 cases: facts 393/400, 0 wrong. Criteria hurt units (20 → 12). |
| `typesafe-ensemble.mjs` (400 × 2 framings × 2 streams) | The median of 6 in-call paraphrases decided 372 → 381; the mean was worse. 0 errors in every arm, so the bench was too easy to test error detection. |
| `typesafe-probes.mjs` | Choice option order: **0 flips in 90**. With empty files, no gate question went GO (max p 0.61). 3 irrelevant files: correct 275 → 252, Brier ×2.3. |
| `typesafe-redteam.mjs` | 12 MiniMax payloads × 30: plain 1/360 wrong GO; quarantine 0; quarantine + criteria 0, with undecided 158 → 44. Poisoned facts: Jev followed a wrong fact 9/60 times and the file 0/60. |
| `typesafe-redteam-adaptive.mjs` (MiniMax-M3, 3 rounds) | Plain frame: up to **33/360** wrong GOs per round. Defended on 1.13.0: 0 wrong GOs, but up to 324/360 undecided. Defended on 1.14.0: **2 wrong GOs** in round 3 (the "systemd EnvironmentFile supplies the settings" story). |
| `typesafe-strip.mjs` (21 payloads × 30) | **Stripping comments: 0 wrong GOs and 0 undecided on both models**, against 83 / 119 wrong GOs plain. Clean accuracy unchanged (466 / 477–484 of 500). Now the default. |
| `typesafe-frame-v2.mjs` + ablation | The full quarantine frame cost 1.13.0 some decisiveness on clean input (478 → 459); the individual parts are within noise. It stays opt-in. |
| `typesafe-product.mjs` (through `verifyFiles` + `facts.mjs`) | 106 → **117/120** correct on 1.13.0 and 109 → 116 on 1.14.0, 0 wrong. |
| MiniMax-M3 review of `facts.mjs` (falsifiable format) | 4 runnable cases, **4/4 real**, all one root cause: nginx `;` terminators (`10k;` → null). Fixed, with a test. The first attempt failed when the reasoning used the whole 24k token budget; it succeeded at 60k. |

## 2026-10-18: round 7 (v0.10)
| experiment | headline |
|---|---|
| `typesafe-yaml-injection.mjs` (5 non-comment YAML payloads × 4 values, both models) | Plain 0 wrong GOs; **quarantine alone 4/4** (the `overrides:` block); facts with the flat `key` matcher **4** (the extractor read the attacker's nested key, so the trusted fact was poisoned); facts with a YAML `path` **0**; quarantine + facts **0**, with 16/20 correct refutations. Fixed in `facts.mjs` (the `yaml` extractor, `path`, and YAML `key` rejected). |
| `scripts/metrics-report.mjs` on live data | Production over 24 h: 467 requests, 0 5xx, p95 ≤ 560 ms; staging: 2299 requests, 0 5xx. The SLO check works against the Analytics Engine SQL API. |
| Action status functions (`tests/helpers/gha-expr.mjs`) | Modelling GitHub's implicit `success()` showed that the fail step never ran after a failed gate step; `always()` added. |

## Backlog
1. ~~Proof cache~~: done.
2. ~~Compiled-first scheduler~~: done. Ship refute-only.
3. ~~Per-source calibration~~: done. Ship `source_thresholds`; leave Jev raw.
4. ~~Decomposition vs direct~~: done. Decompose for counting and vague questions; ask explicit conjunctions directly.
5. ~~Choice/Score gates~~: done. Ask about the field, derive the propositions.
6. ~~Edge predicates~~: done (Dynamic Workers).
7. ~~Drift detector~~: done.
8. ~~MiniMax agent~~: done.

Round 5: ~~metamorphic default + generation retries~~ (R5-A), ~~grouping rollout~~ (R5-B, module + auto-trigger), ~~automatic tolerance~~ (R5-C), ~~tool profiles~~ (R5-D), plus R5-E (model pinning).

Next (round 7):
- Live Groq and DeepSeek paths (providers ready; keys pending): an independent fast LLM proof path, bulk paraphrase/attack generation, and DeepSeek prefix-cache accounting.
- Non-comment injection: inline `# …`, unknown directives, Markdown prose; is there a trusted normaliser per format?
- A harder error bench where Jev actually errs, to test whether negation gaps and ensemble spread predict errors.

Carried over from the round-6 plan:
- **Wrong NOs under drift (from R5-A).** Spot-check compiled NOs as well as YESes, and quarantine a predicate whose NO rate jumps against its history (a cheap drift signal that needs no teacher). Measure on the shifted stream.
- **Grouping inside `jev gate`:** plan groups once per config change, store accepted mappings in the state, and ask Choices on later runs. Measure the cost per run and the stability of the derived verdicts across runs.
- **Upgrade rehearsal:** a `jev gate --compare-model jev-1.14.0` mode that reports which verdicts would move before a pin changes (R5-E shows that a few percent do).
- **Teacher audits in production:** sample decided gates for human review in the operator UI, feeding `teacherErrorRate`.
- **Audit-log analytics:** the flip rate per gate over time from the Worker's audit table, as a fragility signal measured in the field.

Earlier "next" items:

- Per-file channels in the drift detector, plus a field-level diff so only the dependent gates reopen.
- Test whether an *uninstructed* agent chooses to use the lattice, and whether it stays honest when lattice verdicts conflict with its own belief.
- Spot-check NO answers too, so false NOs in refute-only mode get corrected (liveness).
- Choice-first verifier: automatically group Noul questions about the same field into one Choice (from item 5).
- Larger validation sets and adversarial (mutated) labels for predicate acceptance (item 2: 20 configs wasn't enough).
