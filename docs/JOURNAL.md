# Build journal

This journal records how the tools in this repo were built: what was decided, which alternatives were considered, what the data said, and what that changed about the process for building the next tool. The goal is a system that gets better at building systems, so every round ends with **process lessons**: rules that change how the next round is run, not just what it outputs.

Each entry follows the same shape:

> **Decision** · options considered · why this one · what happened · what it taught

The two builders are Claude (designing, implementing, judging) and MiniMax (bulk generation: ideas, decompositions, predicates, reviews, generator code). Jev and code are the judges of record. Neither builder's output counts until a gate, a test or ground truth has checked it.

---

## Rounds 0–2 in retrospect (v0.2 → v0.4)

The early rounds weren't journaled live. Reconstructed from the commits, the research log and the experiment outputs, these are the process lessons they produced. Each one is now standing practice.

| # | Lesson | Where it came from |
|---|---|---|
| P1 | **Probe the assumption before building on it.** Five minutes of measurement beats a day of design. | The proof cache was designed for cost. A 40-question determinism probe showed Jev varies on re-ask, which made reproducibility the main purpose and exposed the max-per-path gate flaw. |
| P2 | **Ground truth comes from code, not from a model.** Every experiment uses a seeded generator whose truth is computed. | All benches (`redis-gen.mjs`). It made results comparable across rounds and let model-labelled shortcuts (T10) be scored honestly. |
| P3 | **Key results by case, never by completion order.** | The first calibration run looked like ~50% accuracy per question; async results had been misaligned. |
| P4 | **Grids over floats use integer steps.** | `0.5 + 45×0.01 > 0.95` silently moved a selected threshold. |
| P5 | **Every model contribution is a claim.** MiniMax output (reviews, predicates, decompositions) only counts after a check. | Its review: 1.5 of 7 "bugs" were real. Predicates: teacher-validated code still produced wrong GOs. Decomposition: a paraphrase added a constraint the spec never had. |
| P6 | **Run the same experiment twice when a model writes part of it.** | Two compiles under identical settings gave 8/24 vs 0/5 wrong GOs. One run would have produced either a false alarm or false comfort. |
| P7 | **Look for the null result, and keep it.** | Decomposing explicit ANDs had no benefit; calibrating Jev hurt. Both changed the design (T22, T23). |
| P8 | **Design the failure into the experiment.** | Compiled-first only showed its risk once the predicates were compiled under the *old* rules and the format then shifted. |
| P9 | **Safety and liveness are separate metrics.** Report wrong GOs separately from accuracy. | Refute-only lowers accuracy (false NOs) but keeps wrong GOs at 0, which is the right trade for a gate. |
| P10 | **Prefer the deterministic, inspectable mechanism when it matches the clever one.** | Per-source thresholds matched isotonic calibration, so the gate got `source_thresholds`. |

---

## Round 3 (v0.5)

### 3.0 Planning
**Inputs:** the five "next" items from the research log, plus a MiniMax ideation round on new use cases.

**Decision: how to use MiniMax for ideation.** The prompt gave it the measured facts about each proof source (not marketing claims) and limited it to everyday engineering and operations domains. For each idea it had to say *how ground truth would be computed by code*, applying P2 up front.

**What MiniMax produced** (`docs/journal/round3-minimax-ideation.txt`): 8 use cases (CI gate, Terraform plan gate, dependency guard, CHANGELOG completeness, docker-compose gate, accessibility baseline, API contract guard, ticket triage), ranked by value × ease.

**My review of the ideation:**
- **Hypotheses mostly untestable here.** They needed production history ("500 historical runs", "incidents per quarter"). *Fix:* turn each into a seeded generator with computed truth, the pattern that already works.
- **Misread independence.** It proposed COORDINATED gates from two Jev proofs. Under T5 these share an independence key and count as one path. *Fix:* the next ideation prompt includes the independence rule, and MiniMax's grasp of the design is itself treated as something to test.
- **Wrong tool for some checks.** Several questions are keyword matches (ticket triage), where a regex already *is* the ground truth and Jev adds nothing. *Selection rule:* pick cases where **code can compute the truth from structured data, but the document a verifier must read is prose or deeply nested.** That is where a calibrated reader earns its place.
- Its ranking put CI JSON first. Status fields in CI JSON are trivially parseable, though, so a lattice adds little there.

**Selected for this round:**

| Experiment | Why it's informative | Feature exercised |
|---|---|---|
| R3-A Terraform plans at scale | Long nested state, existential vs universal questions, a 10→300 resource sweep: *where does Jev stop being reliable?* | state size limits, a new split (by data rather than by question) |
| R3-B CHANGELOG vs merged PRs | Prose entries with paraphrase vs structured truth: *where does a compiled regex fail and Jev not?* | refute-only trade-offs, reading prose |
| R3-C Per-file channels | The drift detector re-verified unchanged gates (round 2 finding) | evidence granularity |
| R3-D Metamorphic validation of predicates | 20 configs weren't enough to catch bad code (P6) | predicate acceptance |
| R3-E Choice-first grouping | T24 showed Choice beats Noul; can grouping be automated? | MiniMax as a planner, Jev as the check |
| R3-F Uninstructed agent | Round 2 told the agent to use the lattice. Does it choose to, and does it relay OPEN faithfully? | agent tool fidelity |

**Process decision:** MiniMax writes the *Terraform generator* (R3-A). The question isn't only "is the generator right" but "how much review does MiniMax-written experiment code need", which feeds back into how much of the harness can be delegated next time.

### 3.1 R3-C: per-file evidence channels
**Decision: how to make drift finer-grained.** Options:
- **(a)** A field-level diff inside each file. Precise, but needs a parser per file type, so it is format-specific.
- **(b)** Questions declare which files they `reads`. Proofs record one hash per file, and Jev is sent only those files.
- **(c)** Let Jev decide which files matter. That spends a model call on bookkeeping.

**Chose (b).** It is format-agnostic, deterministic, and the declaration doubles as documentation of each question's dependencies. (a) can come later inside a file if (b) shows the need.

**Built:** `verifyFiles` (questions with the same read-set share one Jev call), `invalidateChangedFiles`, the `reads` field in the spec, and the `jev_verify_files` tool, with a unit test.

**Result** (`per-file-drift.mjs`: 6 repos × 9 questions × 12 turns, one file changes per turn):

| mode | Jev questions | decided & correct | wrong GO | turn-0 decided & correct |
|---|---|---|---|---|
| whole-repo hash | 567 | 0.951 | 0 | 0.963 |
| per-file channels | **159** | **1.000** | 0 | **1.000** |

**What it taught:**
- The expected win was cost. The unexpected one was **accuracy**: Jev is more decisive and more correct when it reads only the relevant file. A smaller state is *better evidence*, not just cheaper evidence.

**Design pivot prompted by the user:** the 72% saving shouldn't be banked as cost reduction. It is **question budget**. When a few questions settle the gate, spare questions can probe what else the evidence reveals, and in particular they can *teach the weaker channels*. "If you know something by sight, let that truth calibrate the smell and sound." That became R3-G, and it adds a principle to the process:

> **P11. Savings are budget for insight.** When an optimisation frees capacity, first ask what the freed capacity could *learn*, then whether to bank it.

### 3.2 MiniMax writes experiment code (R3-A generator): an operational lesson first
The first request (MiniMax-M2.7, 40k max tokens) produced **an empty file**. The CLI aborts each attempt at 180 s and retries on abort, so a long code-generation answer never finished and used up all 4 attempts silently.

- **Fix:** `MINIMAX_TIMEOUT_MS` override and a clear abort message. Long generations now get a 15-minute budget on the highspeed model.
- **Process lesson, P12:** *A delegation channel must fail loudly.* Silent empty output from a helper is worse than an error, because the orchestrator wastes time waiting for it.
- Second side lesson: `pkill -f <pattern>` killed my own shell, because the pattern matched the command line. Use PIDs.

### 3.3 R3-G: cross-sense teaching on the edge
**Decision: where the teaching runs.** The user asked to lean on Cloudflare Workers. The weaker senses already live there (Workers AI, sandboxed predicates), so the label bank lives in the lattice's Durable Object. Teaching, the bank and the learned thresholds all happen at the edge. The experiment script is only a driver that also holds the ground truth.

**Design:**
- **Teacher:** a gate decided (GO or REFUTED) by per-file Jev, the strongest channel measured in R3-C.
- **Senses:**
  - `jev-whole`: Jev reading all files ("blurrier sight").
  - `jev-paraphrase`: Jev on a MiniMax rewording of the question; the paraphrase is cached in the Durable Object.
  - `workers-ai`: the on-edge small model.
  - `compiled`: a sandboxed predicate, if one is registered.
- **Bank:** (p, teacher verdict) per question × sense.
- **Learning:** the lowest threshold with no GO against a teacher NO. If none exists, the sense is blocked for that question (new spec field `blocked_sources`). Sense proofs get their own source type `SENSE:<name>`, so learned bars apply per sense, through the `source_thresholds` field that already existed.

**Why per question × sense, not per sense:** T11 and T22 learned per source. R3-G's first run showed the same sense is reliable on one question and unreliable on another (Workers AI: 1.000 on most questions, 0.775 on AOF, 0.800 on LOG_LEVEL).

**Run 1** (5 repos × 8 turns of teaching, then 5 × 4 test snapshots with no teacher):
- Teacher: 360 labels, **0 wrong**. As a result, teacher-learned thresholds equalled truth-learned thresholds on **29/29** question × sense pairs. Without ground truth, the bank learned what ground truth would have taught.
- Workers AI was blocked on LOG_LEVEL. `jev-whole` needed 0.66 on TLS: the whole-repo state blurred that question, which independently confirms R3-C.
- Test phase: Workers AI recall rose 0.843 → 0.907 with no wrong GOs.
- **But `jev-whole` produced 1 wrong GO** at its learned bar of 0.5. A clean bank of 40 samples is not proof of safety.
- The Worker's combined gates still had **0 wrong GOs and 0 wrong REFUTED** over 180 gates. Another sense disagreed, and CONFLICT blocked the bad GO, so the multi-sense gate covered for one sense's over-learned bar.

**Fix: an earned discount.** A learned bar may drop below `floor` (0.9) only with at least `minGoForDiscount` (30) clean GOs. Rule of three: n clean observations bound the error rate at about 3/n.

**Run 2** (8 teaching repos, floor 0.9, 30 GOs to earn a discount): **0 wrong GOs in every sense.** Workers AI's recall gain held (0.824 → 0.907), because it had earned the discount on common questions. Rarer questions (HSTS) stayed at the floor. Again 29/29 agreement with truth-learned bars.

**What it taught:**
- **Labels from a strong channel are as good as ground truth when the teacher is right**, and per-file Jev was right 360/360 times. The open question is how teacher errors propagate. A deliberately noisier teacher is a good next experiment.
- **Learning must be conservative in proportion to evidence.** This applies to the system itself, not only to models: the meta-layer that tunes the gate needs its own gate.
  > **P13. Every learning loop needs a confidence floor tied to sample size.**
- Running the teaching on the edge cost about 1 s per snapshot, covering teacher + 4 senses × 9 questions. All the learned state sits next to the lattice it calibrates.

### 3.4 Delegation, continued: getting usable code out of MiniMax (R3-A generator)
This took four attempts, and each one changed the process:
1. **M2.7, open spec, 40k tokens:** empty output. The CLI aborted each attempt at 180 s and retried silently (P12).
2. **M2.7-highspeed, 15-minute budget:** still running after 15 minutes. A small request took 17 s, so latency wasn't the issue; the size of the task was.
3. **"At most 110 lines" (M2.7-highspeed, then M3.1-Flash-Preview):** both spent their whole 12–16k token budget on *reasoning* and wrote no code. The prompt asked for a **statistical target**: each risk present in 30–60% of plans for any N, scaled by 1/N. The models tried to *design* a sampling scheme that satisfied it.
4. **The algorithm written out instead** (coin flip per risk, then plant it in one random resource): 112 correct lines on the first try, still with 13k reasoning tokens. An independent truth implementation I wrote (`tf-gen-check.mjs`) found **0 mismatches in 14,700 checks**, with P(yes) ≈ 0.45 for every question and size.

**What it taught:**
> **P15. Delegate in small, bounded, checkable units.**
> **P16. Give the model the algorithm, not the target.** Design (choosing a scheme that meets a property) stays with the designer. The delegate transcribes, and its output is checked by an independent implementation, never by its own tests.

**Model routing** (from the user, mid-round): `MiniMax-M3.1-Flash-Preview` is now the default everywhere: CLI, orchestrator, Worker and agents. `MiniMax-M3` (`--think`) is reserved for big thinking. Flash is served even though `/v1/models` doesn't list it.

### 3.5 R3-B: CHANGELOG completeness, or which way to trust code
**Hypothesis going in:** refute-only (T21) is the safe way to use a compiled predicate. **Data:** the regex "#n appears in this release's section" fails in the *other* direction. It is never wrong when it says yes, and it calls every paraphrase "missing" (73 wrong REFUTED). Refute-only reproduced those 73 errors. Confirm-only (a regex YES is final, a regex NO goes to Jev) matched Jev's accuracy with 34–39% fewer Jev questions.

**Generalisation:** the safe direction depends on the predicate's failure mode. Refute-only was right for the Redis parsers, which over-claim; confirm-only is right for the number regex, which under-claims. The Jev-taught bank picked the right direction automatically (YES precision 1.0, NO 0.72–0.75).

**But the bank was biased.** Truth puts NO precision at about 0.51. The teacher labels only what it can decide, and it abstained on exactly the hard cases (paraphrases), so the bank overstates reliability in the teacher's blind spot. Cross-sense teaching inherits its teacher's blind spots.

**Then a framing fix (T24 applied to matching):** Noul "is this change mentioned?" matched only 24/72 paraphrases (it abstains). Choice "which line describes this change, or none?" matched 72/72. Choice plus a Noul veto on one gate gave **241/245 correct with 0 wrong in either direction**, and with confirm-only on top, 39% fewer Jev questions.

**The two "wrong GOs" along the way were ground-truth bugs.** The generator had drawn two PRs with the same change and component, one paraphrased and one marked missing. Jev's matches were correct.
> **P17. When a trusted verifier disagrees with ground truth, audit the generator first.** Twice this round, the "error" was in my truth.

### 3.6 R3-A: Terraform plans at scale, or split the state and lift the verdicts
A 10 → 300 resource sweep, 24 plans per size, 7 questions (any / all / count). Arms:

| n (≈ tokens) | whole plan | sliced, probability product | **sliced, verdict lifting** |
|---|---|---|---|
| 10 (0.6k) | 0.964 | 0.970 | 0.970 |
| 30 (1.8k) | 0.952 | 0.881 | 0.964 |
| 100 (5.9k) | 0.905 | 0.554 | 0.958 |
| 300 (18k) | 0.929 | 0.530 | **0.976** |

**Findings:**
- **Whole-plan Jev holds up to 18k tokens** with 0 wrong GOs. The long-context header changed nothing at these sizes.
- **Counting degrades whole-plan** ("more than 3 created": 0.54–0.63 at n ≥ 100). Sliced counting by **convolving per-slice Choice distributions** stays at 1.00.
- **Multiplying calibrated probabilities across slices destroys decisiveness.** Each slice's "no" carries about 0.02 of calibration slack; that slack isn't independent risk, but the product treats it as if it were. **Lift the verdicts instead.** "Any" is GO if a slice is GO and REFUTED only if every slice is REFUTED; "all" is the mirror. This is the lattice's own deterministic gate applied one level up, and it is the best arm at 300 resources.
- **The first confident errors in the NO direction:** 1–3 wrong REFUTED per size on the SSH question. A probe traced them to a port *range* (0–65535) that includes 22. Spelling the range out in the question moves Jev from 0.82–0.89 to 0.94–0.95 (T3 again: semantics go into the text).
- One wrong GO under lifting at n=100, on the "every resource tagged" question, so verdict lifting inherits per-slice errors.

> **P18. Compose decisions at the level they were made.** Probabilities are inputs to a gate, not a currency to multiply across gates.

### 3.7 R3-F: the uninstructed agent, inconclusive and why
A MiniMax Flash agent was given a neutral system prompt and the **deployed Worker's** MCP tool list (29 tools over HTTP).

**Observed:**
- It chose the lattice on its own in **8/8** runs.
- It **sprawled**: about 13 tool calls per run, vs 5 when instructed, trying predicates, edge proofs, decompose and MiniMax proofs.
- Only **1/8** runs ended with the requested JSON, so claims couldn't be scored.

**Two design flaws, both mine:**
1. Scoring depended on the agent's output format.
2. The "undecidable" requirement (`appendfsync everysec` absent from the file) wasn't undecidable: Redis *defaults* to `everysec`.

**Next design:** score from the lattice state and the transcript. Pick an "unknown" requirement that has no default. Compare a 29-tool surface with a curated 6-tool surface, since sprawl suggests the tool surface itself is a design parameter.
> **P19. Measure agents from their actions and the system's state, not from their prose.**

### 3.8 Round 3 process lessons, and what changes next round
- P11 savings are budget for insight · P12 delegation fails loudly · P13 learning loops need evidence floors · P15 bounded delegation · P16 algorithm, not target · P17 audit the generator first · P18 compose at the decision level · P19 measure actions, not prose.
- **Changed for round 4:**
  1. Every experiment ships with an independent truth check, as `tf-gen-check.mjs` did.
  2. Delegated code prompts specify algorithms.
  3. Agent experiments score from state.
  4. Default to per-file state: focused evidence was more accurate.
  5. Probe weaker senses with spare budget whenever a gate is decided by sight.
- **Not done this round** (carried over): R3-D metamorphic validation of predicates, R3-E automatic Choice-first grouping, a noisier teacher for cross-sense teaching, and R3-F redesigned as above.

### 3.9 An outside measurement changes a feature (between rounds)
While round 3 was in progress, PR #1 was merged, and the gitpp-side agent posted a measurement made on a different question set. It found 0/45 flips, but every one of its claims sat at 0.97+ or below 0.07; the one claim that wobbled sat at 0.91–0.93. Its argument: **our 7% figure is a near-threshold effect, and the proof cache hides the variance it makes reproducible.**

**Decision: how to respond.**
- **(a)** Note it in the log.
- **(b)** Re-measure here, at three thresholds.
- **(c)** Build the suggested instrument.

**Chose (b) and (c).** The claim was cheap to test and, if true, actionable.

**Built:**
- `margin` and `fragile` on every gate result (normative rules in GATE-SEMANTICS §2.8–2.9);
- `fragility_band` in the spec;
- `stabilityProbe`, which writes the measured spread onto cache entries so cached proofs carry their noise;
- an audit of the cache-miss paths (drift, expiry, invalidation). All of them overwrite through latest-per-path; none *select*. So the "best of N" trap the comment warned about isn't open.

**Measured** (`fragility.mjs`, 160 questions × 6 readings): the flip rate by margin band at t=0.9 was 50% / 7% / 0% / – . **The flag caught 5/5 flips while flagging 4.7% of decided gates.** At t=0.95 it flagged 17.6%, because Jev's readings cluster there (T35).

**What it taught:**
> **P20. Invite outside measurement, and treat it like your own: re-measure before adopting, then build the instrument it implies.** An independent question set exposed a framing error in our own headline number ("7% unreliable" really meant "unstable near the bar"), and it did so cheaply.

---

## Round 4 (v0.6)

### 4.0 Planning
**Inputs:** the five round-4 items from the research log, plus the user's request to think about production readiness, deployment and packaging.

**Ordering decision:** start the slowest, MiniMax-heavy run (R4-D) first, in the background. Then the offline one (R4-C), then the experiments that only need fast calls. Interleaving kept the wall-clock time to about the length of the slowest experiment.

### 4.1 R4-D: metamorphic validation
**Design decision:** compile one candidate set and apply two acceptance tests to the same code. Letting each test retry with feedback would make the comparison about retry luck rather than acceptance.

**A delegation choice:** MiniMax was asked for rewrites "using any syntactic variation the Redis config format allows", deliberately *without* listing the variations used by the shifted generator. Listing them would have leaked the test. Jev's agreement with the original filtered rewrites for meaning; all 40 passed.

**Result:** metamorphic acceptance rejected every brittle predicate in both runs.

**Operational issue found:** only 40–60% of Flash code generations compiled. This is a real cost: production use needs a retry loop, which goes in the round-5 queue.

**A tooling mistake, repeated:** `pkill -f <pattern>` killed my own shell again. Fix: anchor process patterns to the command (`^node experiments/…`).

### 4.2 R4-C: noisy teacher
**Expected:** label noise would make learned bars too *permissive*. **Observed:** the opposite. The zero-disagreement rule converts noise into blocking.

So I added the obvious knob (`tolerance`) and immediately hit its trap. With the real (error-free) Jev teacher, tolerance only admits the *student's* errors. The rule has to be "tolerance = the teacher's measured error rate", which ties the learning loop to the calibration bench.

> **P21. Measure the teacher before you trust its labels, and set the learner's slack from that measurement.**

### 4.3 R4-A: fragility-aware gates, a negative result kept
I expected `require_firm` (fragile verdicts need corroboration) to improve reproducibility. It reduced it. The fragile/firm classification sits on its own noisy boundary, so the rule shifted the flip band from the bar to bar + band. The useful idea from the outside comment survives as **information** (`margin`, `fragile`), not as **policy**.

> **P22. A deterministic rule on a noisy quantity creates a new noisy boundary.** Fix noise at its source (cache the reading), then use the signal for alerting.

### 4.4 R4-E: the agent, measured properly
Applying round 3's lessons (P19: score from state; truth with no default; a tempting balance) produced a clean, positive result: no overclaims in either arm. The tool-surface comparison then showed something round 3 only hinted at. A larger surface doesn't change the *decision*, but it changes the *record*: agents used extra proof sources to "refute" an unknowable requirement from absence of evidence. That matters for production: whatever an agent records becomes evidence for the next decision.

### 4.5 R4-B: Choice-first grouping
MiniMax's grouping came out sensible on the first try, including "not set" options and multi-question mappings (port 0 / port 6379 from one Choice; bind loopback / all from one Choice). Validation against Jev's own Nouls was the gate; it rejected the one mapping with too little confident data.

### 4.6 Round 4 process lessons
- P21 measure the teacher · P22 rules on noisy quantities move boundaries.
- **Background the slow run first:** MiniMax-heavy experiments ran while three others were built and run.
- **Keep negative results as tiles** (T38), so the next round doesn't rebuild the same rule.

### 4.7 Production review: measure before planning
**Decision:** before writing a production plan, measure the suspected risks: package contents, scaling, input handling. Three measurements changed the plan:
1. **`npm pack` shipped 110 files and 826 kB**, including experiments, raw results and the journal. A `files` whitelist brought it to 36–40 product files and about 270 kB.
2. **`consolidate()` was O(n²)–O(n³):** 3.6 s at 500 nodes, and 2,000 never finished. A spatial grid, a degree cap and batched merge remapping brought 500 nodes to 54 ms, and spread lattices became roughly linear (20k in 0.43 s). Clustered 20k still takes 37 s, so lattice size budgets went into P0.
3. **MCP tool arguments were not validated:** `{text: 42}` leaked an internal error, and `question_spec: "nope"` silently created a default gate. A schema validator now checks every call.

**Packaging decision: CLI and GitHub Action first, hosted edge last.**
- The CI tier needs no service.
- It fails closed.
- It sends only the read files to the verifier.
- Its steady-state cost is zero, because proofs on unchanged files are reused.

The edge tier is technically ready but needs tenancy, quotas and an audit log before anyone outside the team uses it (PRODUCTION.md §4).

> **P23. A production plan starts with measurements of the current system, not a feature list.** Three of the top-priority items came from measurements, not from reading the code.

---

## Round 5 (v0.7): P0 production work + experiments

### 5.0 Planning
**Inputs:** the six P0 items in PRODUCTION.md §4 and the four round-5 research items, plus one added experiment: a model-upgrade comparison (R5-E), so that the case for pinning would rest on a measurement and not an argument.

**Ordering.** P0 first, because it changes the deployed system and every later smoke test depends on it. Live experiments were started in the background as soon as their library code existed: R5-E right after the pinning change, R5-A as soon as metamorphic acceptance was in `compiled.mjs`, R5-B once `grouping.mjs` had tests. Offline work (R5-C, types, conformance, docs) filled the waits.

### 5.1 The control plane: one decision per layer
- **Where authorisation lives.** The obvious place was the Worker, but the tool list, quotas and the audit diff all need lattice state, which lives in the Durable Object. The split chosen: the Worker authenticates, checks lattice access and rate-limits; the DO gets a `principal` and builds a per-request `ctx` (`allow`, `guard`, `profile`) that `mcp-core` enforces.
- **Why `mcp-core` grew `ctx`** instead of the DO wrapping it: the same hooks now serve the stdio server (`JEV_PROFILE`) and any other host. Refusals come back as MCP results with `isError` and a `forbidden:` / `quota:` reason, never as protocol errors, because agents can read and react to a result but often just retry a protocol error.
- **Scopes by consequence, not by verb.** `read ⊂ verify ⊂ admin` are defined by what a call can change: nothing; add evidence; replace the lattice or its policy. Unknown tools default to `verify`, not `read`, so a new tool can never quietly be readable-and-mutating.
- **Audit the decision, not the request.** Each mutating call snapshots every question's verdict before and after, and records only the changes, with the proofs that caused them. That costs O(questions) gate evaluations per call, which is affordable under the 5000-node quota, and it answers the operator's real question: *who moved this gate?*
- **Providers per lattice.** The default sends evidence only to TypeSafe. That changed the smoke test, which now has to opt a lattice in to MiniMax, Workers AI and predicates. That is the intended friction.

**A measurement that changed the config:** the rate limiter with a 60 s period limited 0 of 600 rapid requests; with a 10 s period it limited 37 of 300. Cloudflare documents the binding as permissive and eventually consistent. We kept 50/10 s and documented it as abuse protection, not billing.

### 5.2 Delegating the security review to MiniMax-M3, and why it worked this time
Round 1's MiniMax code review was mostly wrong (1.5 of 7 findings real). This round's prompt ([prompt](journal/r5-control-plane-review.prompt.md), [output](journal/r5-control-plane-review.minimax-m3.md)) was different in three ways:
1. It stated a **threat model** (what a tenant must not be able to do).
2. It required **a concrete request sequence** for each finding.
3. It asked the model to **say when it was unsure**.

Result: 10 findings, **8 real, 1 partly real, 1 false**, and the false one (#7, the `importState` shape) was the one MiniMax had itself marked "not sure".

| # | finding | verdict | action |
|---|---|---|---|
| 2 | body-size limit bypassed by a chunked upload with no `content-length` | **real, the most important** | the body is read through a byte-capped reader; smoke: a 5 MiB chunked body → 413 |
| 1 | failed auth is never rate-limited; unbounded secret length | real | secret ≤ 128 chars, header ≤ 512; failed auths limited per IP |
| 3 | audit `node` filter used `LIKE`, so `%` matched everything | real (low; no cross-tenant data) | exact match through `json_each`; smoke: `?node=%` → 0 rows |
| 4 | the idle cycle triggered via REST was attributed to `system:idle` | real | the caller's id is recorded |
| 5, 6 | timing differences: unknown vs known key id; root configured or not | real, negligible | hash before the lookup; always compare against root |
| 8 | a corrupted key row → 500 for every request with that key | real (robustness) | parse errors fail closed (401) |
| 9 | no record of key management | real (defence in depth) | an append-only `key_events` table, `GET /admin/events` |
| 10 | probing lattices creates Durable Objects | partly real: probing needs a `*` key, but a *read* of an unused lattice wrote storage (the audit table) | the audit table is created on first write |
| 7 | the import quota is bypassed by a non-array `nodes` | **false**: `importState` rejects it untouched | none |

> **P24. A reviewer model's precision is a function of the prompt's falsifiability.** Asking for an exploit sequence per finding, against a stated threat model, and an explicit "not sure", turned MiniMax from a noisy reviewer (21% real) into a useful one (85% real). Its uncertainty label was calibrated: the one finding it flagged was the one that was wrong.

### 5.3 API freeze: writing the spec as data found a spec bug
Conformance vectors were written **by hand** from GATE-SEMANTICS.md, not generated from the implementation (otherwise they would only test the code against itself). All 27 matched. While computing one expectation by hand I hit the spec's claim that an OPEN margin is ≤ 0. For a COORDINATED gate with one strong path and two required, the margin is +0.14. The code was right and the document wrong; that is now fixed, and the case is a vector.

Hand-written TypeScript declarations can drift silently, so a test imports each module and checks that every value a `.d.ts` exports really exists. `tsc` checks a usage file that imports through the package's own `exports`.

> **P25. Turn prose specs into executable data, and write the expectations by hand.** Generating expected values from the implementation tests nothing; computing them from the spec tests the spec too.

### 5.4 R5-E: measure the case for pinning
**Design:** run three passes: the old model twice (that is the noise floor) and the new model once. An upgrade "flip" only means something compared with the re-ask flip rate. **Result:** the upgrade moves 2–2.5× more verdicts than re-asking, and moves p about 3× more, with unchanged accuracy. So pinning is about **reproducibility and auditability**: a verdict that changes with no change in the evidence is exactly what the new audit log would flag as unexplained.

### 5.5 R5-A: what the retry loop fixed and what it exposed
Extracting code from fences and bare arrows, plus regenerating unusable output, took usable candidates from 60% to 85–90%. Metamorphic acceptance again gave 0 wrong GOs. But looking at **both** error directions, which R4-D's summary had underplayed, showed that every arm produced 15–45 wrong NOs after the format shift. Meaning-preserving rewrites of the *training* distribution don't anticipate a new format. Under refute-only trust a wrong NO is a wrong REFUTED. That is safe (fails closed) but a liveness failure, and it sets round 6's first item: spot-check NOs, and use a jump in the NO rate as a teacher-free drift signal.

> **P26. Report both error directions in every table, even when only one is "the safety metric".** The direction you aren't optimising is where the next failure is hiding.

### 5.6 R5-B: productising found a latent bug in the experiment
Moving the grouping logic from an experiment into `grouping.mjs` meant writing a unit test with two groups mapping the same question. It failed: derived answers were keyed by question only, so the later group silently overwrote the earlier one. R4-B's own data mapped each question once (checked), so its numbers stand. The test exists because a library must handle inputs that an experiment happens not to produce. On generalisation, the most informative result was an **abstention**: for three redis questions on three different settings, MiniMax proposed no groups at all, which the prompt explicitly allowed ("it is fine to return no groups").

> **P27. Give the proposer an explicit way to say "nothing here".** A proposal step that must always return something will invent groupings; with the option to abstain, MiniMax grouped only same-field questions.

### 5.7 R5-C: an allowance that scales with evidence
R4-C's fixed `tolerance` was a fraction, which is wrong at both ends: `floor(3% × 20) = 0` forgives nothing on small banks, and 3% of 400 forgives too much. The binomial allowance asks how many "no"s a teacher with flip rate ε would produce among m samples, at 95%. It beat every fixed tolerance up to 5% noise with 0 wrong GOs. Two limits were found and kept in the docs: above ~10% noise it forgives the student's own errors, and the audit's *upper* bound is too loose (it produced wrong GOs with a perfect teacher). The point estimate from a 30-label audit was close to the true ε.

### 5.8 Round 5 process lessons
- P24 falsifiable review prompts · P25 hand-computed executable specs · P26 report both error directions · P27 let proposers abstain.
- **Unit-testing code lifted out of an experiment** found a bug the experiment couldn't (5.6). Productising is itself a test.
- **Every P0 change came with a live smoke check** (49 checks now). Writing a check first is how the rate-limiter period problem surfaced.

---

## Round 6 (v0.8): learning TypeSafe Jev by experiment

### 6.0 Plan and division of labour
- **The user's ask:** learn typesafe.ai through extensive use and research what others have done with it.
- **Division of labour:**
  - A research agent read TypeSafe's docs index and about 10 public evaluations.
  - I probed the API directly in parallel.
  - MiniMax wrote paraphrases and attacks, and reviewed the new extractor code.
  - Jev answered about 40k questions.
- **Mid-round instruction:** conserve Claude tokens and lean on MiniMax, TypeSafe, Cloudflare, Groq and DeepSeek. Groq and DeepSeek keys weren't in the session, so their providers were built and tested offline, and their live runs are queued for round 7.

### 6.1 Probe before believing
Three facts came from probing the API itself, not from documentation:
- Score criteria must be a list.
- Unknown top-level fields are rejected with a bare 400.
- `jev-preview` currently serves 1.14.0.

The research agent then supplied what probing can't: the Noul criteria shape, the limits, the price, and TypeSafe's own list of weak spots. **Each vendor claim was re-measured where it mattered.** The "leans toward the first option" claim did not reproduce on our questions (0 flips in 90 reorderings).

### 6.2 Make the bench hard enough to teach something
The redis bench had saturated: 0 errors in every arm of the ensemble experiment, so it could say nothing about error detection. The hard generator targets the documented weak spots (units, overrides, counting, cross-file references, defaults), with truth computed by code. Even there, Jev failed *safe* (it left questions undecided rather than answering wrongly). The useful measure became "decided-correct", and each lever was judged by how many undecided cases it resolved without adding errors.

> **P28. When the judge stops making errors on your bench, the bench is done teaching. Build one aimed at the judge's documented weak spots, and measure what turns undecided into correct.**

### 6.3 Facts are the strongest lever and the sharpest knife
Code-computed facts resolved 19 of 21 undecided cases. The poisoned-facts arm was designed in the same run, because a lever this strong is also an attack surface: Jev followed wrong facts 9 of 60 times and never followed the file over them. Hence the rule in `facts.mjs`: plain, tested extractors, never model-written, "not set" rather than a guess. The first outside review of those extractors (MiniMax-M3, falsifiable format) found a real bug at once: nginx `;` terminators.

### 6.4 The security result came from iterating the attacker
One-shot attacks suggested framing was enough (1 wrong GO in 360). An adaptive attacker that saw its own scores found a story Jev couldn't check (settings supplied by a systemd `EnvironmentFile`) and broke the defended frame on 1.14.0. The fix wasn't a better argument to Jev but deleting the content: comments mean nothing to these formats, so trusted code strips them. That took wrong GOs to 0 on both models, with clean accuracy unchanged, and it is now the default.

> **P29. Test defenses against an attacker who sees the scores. A defense that only argues with the attacker (framing, policies, criteria) moves with the model version; a defense that removes the attacker's channel doesn't.**

### 6.5 Model-dependent results are the norm
The quarantine frame was neutral on 1.14.0 and cost decisiveness on 1.13.0. Criteria helped cross-file questions and hurt unit questions. Every default chosen this round was checked on both models before it shipped (file descriptions on; quarantine opt-in; stripping on).
