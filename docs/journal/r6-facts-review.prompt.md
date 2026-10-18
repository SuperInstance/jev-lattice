Review facts.mjs (below): small extractors whose outputs a verifier model treats as authoritative facts about config files. A wrong value from an extractor leads to a wrong security verdict.

For each bug you find, give a concrete input that I can run, in exactly this JSON form:
{"extractor": "<name>", "text": "<file content>", "spec": {…}, "expected": <correct value per the file format's real semantics>, "why": "<one sentence>"}

Only report inputs where you are confident the current code returns something other than `expected`. Formats to consider: redis.conf, YAML-ish `key: value`, nginx-style `key value;`, .env files (export, quotes, comments, spaces), JSON, Redis size units (1k=1000, 1kb=1024, case-insensitive), durations (ms/s/m/h). If you are unsure about a format's semantics, put "unsure" in `why`.
Reply with JSON {"cases": [...]} with at most 15 cases.
