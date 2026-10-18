# Guide: running and adding experiments

**Audience:** you want to reproduce a result, test a new verifier or pattern, or extend the research.

## Ground rules (from the journal; each one cost us a wrong result first)
1. **Ground truth comes from code**: a seeded generator whose truth is computed from the generated data (P2).
2. **Ship an independent truth check** with every generator, written separately from the generator (`tf-gen-check.mjs`; P16).
3. **Key results by case, never by completion order** (P3).
4. **Grids use integer steps** (P4).
5. **Run model-written parts twice**; one run can mislead in either direction (P6).
6. **Report safety (wrong GO) separately from accuracy and abstention** (P9).
7. **When a trusted verifier disagrees with truth, audit the generator first** (P17).
8. **Measure agents from the system's state, not their prose** (P19).

## Running the existing experiments
Set `TYPESAFE_AI_TOKEN` and `MINIMAX_TOKEN`. Experiments that use the edge also need `JEV_API_KEY` and a deployed Worker.

| script | question it answers | typical cost |
|---|---|---|
| `calibration.mjs` | How calibrated are Jev, MiniMax and Workers AI? (`--rows` dumps raw data) | 1 Jev call per config |
| `calibrate-sources.mjs` | Isotonic maps vs per-source thresholds, fit and eval split | offline (uses rows) |
| `fragility.mjs` | Flip rate as a function of margin; does `fragile` predict flips? | (R+1) calls per config |
| `proof-cache.mjs` | Cache + hash invalidation across multi-turn drift | ~40–100 Jev calls |
| `per-file-drift.mjs` | Per-file channels vs whole-repo hashing | ~120 Jev calls |
| `cross-sense.mjs` | Learning sense thresholds from decided gates (edge) | Worker + Workers AI |
| `compile-parser.mjs`, `compiled-first.mjs` | Compiling questions into code; trust modes under shift | MiniMax heavy |
| `changelog.mjs` | Prose matching: regex vs Noul vs Choice; trust direction | 1 call per release |
| `terraform-scale.mjs` | Long structured states: whole vs sliced (probability vs verdict lifting) | ~650 Jev calls |
| `decompose-vs-direct.mjs`, `choice-score-gates.mjs` | Composites; Choice/Score as gates | 1 call per config |
| `minimax-agent.mjs`, `uninstructed-agent.mjs` | Agents driving the lattice (instructed / neutral) | MiniMax + Jev |

Results land in `experiments/results/` (use `--out`). Interpretations go into [../RESEARCH-LOG.md](../RESEARCH-LOG.md); how the experiment was designed, and what went wrong along the way, goes into [../JOURNAL.md](../JOURNAL.md).

## Generators
| file | domain | traps |
|---|---|---|
| `redis-gen.mjs` | redis.conf | commented directives, later overrides; `makeShiftedGenerator` for format drift (case, quotes, tabs, gb units) |
| `repo-gen.mjs` | redis.conf + nginx.conf + app.env | per-file questions with `reads` |
| `tf-gen.mjs` (MiniMax-written) + `tf-gen-check.mjs` | Terraform plan JSON | port ranges covering 22, replacements, vacuous "all" |
| inline in `changelog.mjs` | CHANGELOG vs merged PRs | paraphrases, wrong-release entries; unique (change, component) per release |

## Adding an experiment: template
1. **The hypothesis, with a falsifying result** written down *before* running.
2. **A generator with code truth**, plus an independent check over thousands of samples.
3. **Arms that differ in one thing**; include the naive baseline.
4. **Metrics:** decided-and-correct, OPEN (abstention), wrong GO, wrong REFUTED, and verifier calls or tokens.
5. **Two runs** if any part is model-written.
6. **Write-up:** a RESEARCH-LOG table + one paragraph; a JOURNAL entry (decision · options · why · what happened · what it taught); a new tile in [../TILES.md](../TILES.md) if a reusable pattern emerged.

## Delegating to MiniMax effectively
- **Default `MiniMax-M3.1-Flash-Preview`; `--think` (`MiniMax-M3`) for design or ideation.**
- **Specify algorithms, not statistical targets.** A "30–60% balanced for any N" request made models spend 12–16k tokens reasoning and write nothing.
- **Bound the size** ("≤ 110 lines"), and validate the output with independent code.
- **Long generations:** set `MINIMAX_TIMEOUT_MS` / `MINIMAX_MAX_TOKENS`. The CLI warns when reasoning used the whole budget.
- **Treat reviews and ideas as claims.** In one review, 1.5 of 7 "bugs" were real. Ideation produced untestable hypotheses until we required code-computable truth.
