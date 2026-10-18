# Gate semantics (normative)

This is the specification of `evaluateGoNoGo` in `jev-core.js`. A conforming implementation, in any language and on any host, must produce the same verdict, margin and fragile flag for the same lattice state and the same `now`. The reference tests are `tests/core.test.mjs` and `tests/regressions.test.mjs`. Where this document and the code disagree, that is a bug; please report it.

Key words: **MUST**, **SHOULD** and **MAY** follow RFC 2119.

## 1. Inputs

A **question node** has `node_type: "QUESTION"`, a `question_spec`, and `active_proofs` (an append-only array).

### 1.1 Normalised `question_spec`

| field | type | default | notes |
|---|---|---|---|
| `evaluation_mode` | `"BINARY"` \| `"COORDINATED"` | `"BINARY"` | Anything other than `COORDINATED` (case-insensitive) is BINARY. |
| `required_independent_proofs` | integer ≥ 1 | 1 | Ignored for BINARY, which always requires 1. |
| `confidence_threshold` | number in [0, 1] | 0.85 | `0` is a valid value (no `\|\|` coercion). |
| `max_proof_age_ms` | number > 0 \| null | null | |
| `allowed_sources` | string[] \| null | null | |
| `blocked_sources` | string[] \| null | null | |
| `source_thresholds` | {source_type: number in [0, 1]} \| null | null | Non-numeric entries are dropped. |
| `block_on_conflict` | boolean | true | Only an explicit `false` disables it. |
| `reads` | string[] \| null | null | Informational for the gate; used by verifiers. |
| `fragility_band` | number in [0, 1] | 0.02 | |

A QUESTION with no `question_spec` MUST get the normalised defaults: a BINARY gate. It MUST NOT evaluate to GO without proofs.

Numeric parsing: `null`, `undefined`, `""`, booleans and non-finite values take the default.

### 1.2 Normalised proof
`{proof_id, source_type ("UNKNOWN" if missing), confidence ∈ [0,1] (default 0.5), cost_weight ∈ [0,1] (default 0.5), timestamp (ISO; default now), note?, provider?, model?, independence_key?, evidence?, invalidated?}`. A confidence of `0` is preserved.

## 2. Algorithm

Given a node *n*, its spec *s*, and an evaluation time `now` (default: the current time):

1. **Not a question.** If `n.node_type !== "QUESTION"`, return `{go: true, gated: false}`. Observations are not gates.
2. **Live proofs.** Take `active_proofs` in array order and keep a proof *p* only if:
   - `!p.invalidated`;
   - `s.allowed_sources` is null, or contains `p.source_type`;
   - `s.blocked_sources` is null, or does not contain `p.source_type`;
   - `s.max_proof_age_ms` is null, or `now − Date.parse(p.timestamp) ≤ max_proof_age_ms` (an unparseable timestamp drops the proof).
3. **Paths.** `key(p) = p.independence_key ?? (p.provider ? source_type + ":" + provider : source_type)`. For each key, the path's reading is the **last** live proof with that key in array order. It is *not* the maximum (see §4.2).
4. **Bars.** `bar(p) = s.source_thresholds?.[p.source_type] ?? s.confidence_threshold`.
5. **Classify paths.** A path is *supporting* if `confidence ≥ bar` and *refuting* if `confidence ≤ 1 − bar`. When bar < 0.5, one path can be both; implementations MUST evaluate both conditions independently.
6. **Required.** `required = mode == BINARY ? 1 : s.required_independent_proofs`.
7. **Verdict.**
   - `satisfied = |supporting| ≥ required`
   - `conflict = satisfied ∧ |refuting| > 0`
   - `go = satisfied ∧ ¬(conflict ∧ s.block_on_conflict)`
   - `verdict = conflict ? "CONFLICT" : satisfied ? "GO" : |refuting| > 0 ? "REFUTED" : "OPEN"`
   - `open = ¬go`
8. **Margin.**
   - If `satisfied`: rank the supporting paths by `confidence − bar` in descending order. The *decider* is the `required`-th of them, the weakest path still needed. `margin = decider.confidence − bar(decider)`.
   - Else, if there are refuting paths: the decider is the refuting path with the largest `(1 − bar) − confidence`, and `margin` is that value.
   - Else (OPEN): `margin = max over paths of max(confidence − bar, (1 − bar) − confidence)`. This is ≤ 0 and measures how far the gate is from any decision; it is `null` when there are no paths.
   - Round to 4 decimals.
9. **Fragile.** `fragile = decider exists ∧ margin < max(s.fragility_band, decider.evidence.spread ?? 0)`. OPEN gates are never fragile.

### 2.1 Output fields
These MUST be present: `ok`, `go`, `gated`, `open`, `verdict`, `mode`, `required`, `threshold`, `validProofs` (|supporting|), `refutingProofs`, `paths`, `liveProofs`, `ignoredProofs`, `bestConfidence` (the maximum path reading), `proofSources`, `multiProofSalience` (1 − Π(1 − cᵢ) over paths), `margin`, `fragile` and `reason` (free text). The text of `reason` is **not** normative.

## 3. Mutations that affect the gate

| operation | effect |
|---|---|
| `addProof(id, p)` | Appends a normalised proof. It supersedes the path's previous reading. |
| `invalidateProof(id, proof_id, reason)` | Sets `invalidated` with a reason and timestamp. The proof stays in the array for audit. |
| `importState(state)` | Normalises nodes and proofs exactly as above. It MUST reject a non-array `nodes` without modifying the lattice. |

Providers and orchestration code MUST NOT decide verdicts. They only append proofs, or invalidate them.

## 4. Rationale (non-normative)

### 4.1 Independence
Two readings from the same verification path aren't independent evidence. Without keys, the same parser added twice would satisfy a COORDINATED gate (this was a v0.2 bug).

### 4.2 Latest, not best
Verifiers such as Jev aren't bit-deterministic: about 7% of readings near 0.9 flip when re-asked. Keeping the maximum per path lets a caller re-ask until the gate passes, which launders a noisy judge into a confident verdict. With latest-wins, a re-read can also clear its *own* earlier refutation without creating a CONFLICT with itself.

### 4.3 Conflict blocks
A confident "no" from any path is evidence against GO that must not be averaged away.

### 4.4 Margin and fragility
Measured on Jev, re-ask flips concentrate within 0.02 of the bar: a 50% flip rate there, 7% at 0.02–0.05, and 0% beyond. A verdict's distance from its bar predicts its stability without re-asking (`experiments/fragility.mjs`). A measured spread (`stabilityProbe`) makes the band per-question.

## 5. Conformance checklist
- [ ] QUESTION without spec → BINARY 0.85, OPEN with no proofs
- [ ] `confidence: 0` and `confidence_threshold: 0` are preserved
- [ ] the same key twice counts as one path; the latest reading wins
- [ ] invalidated, expired, disallowed and blocked proofs are ignored
- [ ] per-source bars apply to both support and refutation
- [ ] CONFLICT blocks GO unless `block_on_conflict: false`
- [ ] COORDINATED margin uses the `required`-th best supporting path
- [ ] fragile uses `max(band, decider.evidence.spread)`
