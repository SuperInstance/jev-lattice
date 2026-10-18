# Guide: gating CI and deploys with `jev gate`

**Audience:** you want a pipeline to stop when a file-level requirement isn't met. Examples: "TLS is enabled in redis.conf", "DEBUG is off in the prod env file", "no security group opens SSH to the world".

## 1. Write `jev.gates.json`
```json
{
  "rules": "redis.conf: later directives override earlier ones; # lines are comments. .env files: KEY=value per line.",
  "threshold": 0.9,
  "gates": [
    { "id": "redis-tls",  "question": "Is TLS enabled (a tls-port is configured)?",         "reads": ["deploy/redis.conf"] },
    { "id": "redis-auth", "question": "Is password authentication (requirepass) configured?", "reads": ["deploy/redis.conf"] },
    { "id": "no-debug",   "question": "Is DEBUG disabled in app.env?",                       "reads": ["deploy/app.env"],
      "spec": { "confidence_threshold": 0.95 } }
  ]
}
```

**Writing good questions** (each rule is a finding in [../TILES.md](../TILES.md)):
- **One condition per gate.** Jev answers explicit ANDs well, but separate gates give separate, actionable verdicts.
- **Put reading rules in `rules`**, not in every question (T3). Spell out semantics that are easy to misread, such as port ranges or units (T33).
- **`reads` should list only the files that matter.** Focused evidence is cheaper and more accurate (T28).
- **For "at least N of …" counting questions**, use separate gates and count in your pipeline (T23).
- **Thresholds:** 0.9 sits in a gap of Jev's score distribution. At 0.95 more verdicts are close to the bar, i.e. fragile (T35).

`jev check-config` validates the file and reports every problem at once.

### Hard questions: facts, focus, criteria, quarantine
Jev reads literally and is weakest at units, last-wins overrides, defaults and counting. Let code compute those values and Jev judge them ([typesafe.md](typesafe.md) §3):
```json
{
  "facts": { "deploy/redis.conf": [
    { "name": "maxmemory_bytes", "extract": "size", "key": "maxmemory" },
    { "name": "protected_mode", "extract": "directive", "key": "protected-mode", "default": "yes (default)" } ] },
  "quarantine": false,
  "gates": [
    { "id": "mem", "question": "Is maxmemory at least 1 GiB (1073741824 bytes)?", "reads": ["deploy/redis.conf"],
      "focus": "the maxmemory directive",
      "criteria": { "true": "maxmemory converts to 1073741824 bytes or more",
                    "false": { "what": "fewer bytes, or not set", "not_for": "commented-out lines" } } }
  ]
}
```
- **Extractors** (`facts.mjs`): `directive`, `size` (Redis units), `duration` (ms/s/m/h), `env`, `json` (dotted path), `count` and `regex`. A missing value becomes `"not set"` unless you give a `default`. On the hard bench these took gates from 106 to 117 correct out of 120, with 0 wrong.
- **Facts are trusted.** Jev follows a fact over the file, so a wrong extractor means a wrong verdict. Prefer the built-in extractors, which are unit-tested.
- **`strip_comments`** (default `true`) removes full-line comments before Jev reads the files. Comment-only injection attacks produced 13–19% wrong GOs without it, and 0% with it, at no cost in clean accuracy. Set it to `false` only for questions about comments.
- **`quarantine: true`** frames the files as untrusted data and tells Jev that comments are never instructions. Use it when the files come from people you don't control (forks, user uploads): under 360 injection attempts it took wrong GOs from 1 to 0.
- **`jev lint`** asks each gate about empty files and flags gates that would pass with no evidence, as well as wide `reads` and negated phrasing. Run it after editing gates.

## 2. Run it locally
```bash
export TYPESAFE_AI_TOKEN=…
npx -p jev-lattice jev gate                    # or: node bin/jev.mjs gate (in this repo)
npx -p jev-lattice jev gate --format markdown  # table for PR comments
npx -p jev-lattice jev gate --offline          # evaluate saved proofs only, no API calls
```

| exit code | meaning |
|---|---|
| 0 | every gate is GO |
| 1 | at least one gate is not GO: REFUTED, OPEN, a missing file or a verifier error (**fails closed**) |
| 2 | usage or config error |

State is saved in `.jev/state.json` (`--state` to change it). The next run reuses proofs for unchanged files, so a run with no changes makes no API calls. Commit the state, or cache it (the Action does the caching).

## 3. GitHub Actions
```yaml
name: deploy-gates
on: [pull_request]
jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: SuperInstance/jev-lattice@v0.7      # pin a tag or a commit SHA
        with:
          config: jev.gates.json
          typesafe-token: ${{ secrets.TYPESAFE_AI_TOKEN }}
          model: jev-1.13.0                        # the default; change it deliberately
```
**Pin the verifier model.** Moving from `jev-1.13.0` to `jev-1.14.0` changed 4.7–6.2% of verdicts on our bench, 2–2.5× the rate of simply re-asking (`experiments/model-upgrade.mjs`). Accuracy didn't change, but a verdict that moves without a code change is noise in a pipeline. The proof cache keys on the model, so after an upgrade every gate is re-verified once. Locally, set `JEV_MODEL`.

The Action restores and saves the state through `actions/cache`, writes a Markdown table to the job summary, fails the job when any gate isn't GO, and exposes `outputs.pass`.

## 4. Reading the output
```
### JEV gates: ❌ not all GO
| gate | verdict | margin | note |
| ✅ `redis-tls` | GO | 0.06 | binary proof satisfied |
| ❌ `no-debug`  | REFUTED | 0.08 | refuted by proof |
Re-verified after changes to: `deploy/app.env`
```
- **margin** is how far the deciding reading is from the threshold.
- **⚠️ fragile** means the margin is within the verifier's noise (about 0.02). Treat it as "decided, but would be worth a second look".
- **OPEN** means the evidence doesn't settle the question. That is common when the property isn't in the file at all. Fix the question, or add the file that holds the evidence.

## 5. What leaves your machine
Only the contents of the files listed in each gate's `reads` (plus your `rules` and the question text), sent to TypeSafe's API. Nothing is sent when the files haven't changed since the last run, or with `--offline`.
