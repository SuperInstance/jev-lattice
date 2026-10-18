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

## Backlog (curated; some ideas from a MiniMax brainstorm)
1. ~~**Proof cache**~~: done, see above.
2. **Compiled-first scheduler**: try accepted predicates before Jev, and fall back when the predicate throws or the input is outside its training distribution.
3. **Per-source calibration** (Platt/isotonic) fitted on the bench and applied in `noulToProof` / `proveWithLLM` before the gate.
4. **Decomposition vs direct**: on composite questions with code truth, does decompose → fan-out → roll-up beat one direct Noul?
5. **Choice/Score primitives as gates**: a Score with a threshold level, or a Choice with an allowed set. Jev's `confidence` field acts as a second axis (confidence-gated routing).
6. **Predicates in the Worker**: run compiled predicates at the edge using Worker Loader / dynamic isolates rather than `node:vm`, which is not a sandbox.
7. **Drift detector**: a DO alarm diffs the auto-verify state and invalidates only the proofs whose evidence changed.
8. **MiniMax Anthropic-compatible endpoint** (`https://api.minimax.io/anthropic`, verified working): run bulk sub-agents on MiniMax for cheap exploration and keep Jev plus code as the judges of record.
