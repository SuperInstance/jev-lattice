import test from "node:test";
import assert from "node:assert/strict";
import { parseSize, parseDuration, EXTRACTORS, extractFacts, checkFactSpecs, factsForFiles } from "../facts.mjs";

test("sizes use Redis unit semantics", () => {
  assert.equal(parseSize("1gb"), 1073741824);
  assert.equal(parseSize("1G"), 1e9);
  assert.equal(parseSize("1024MB"), 1073741824);
  assert.equal(parseSize("1048576kb"), 1073741824);
  assert.equal(parseSize("1073741824"), 1073741824);
  assert.equal(parseSize("lots"), null);
});

test("durations", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("1.5s"), 1500);
  assert.equal(parseDuration("2m"), 120000);
  assert.equal(parseDuration("10"), null, "a bare number has no unit: refuse to guess");
});

test("directive: last uncommented wins, case-insensitive, inline comments stripped", () => {
  const conf = "appendonly no\n# appendonly yes\nAPPENDONLY yes # turned on\n";
  assert.equal(EXTRACTORS.directive(conf, { key: "appendonly" }), "yes");
  assert.equal(EXTRACTORS.directive("port 6379", { key: "appendonly" }), null);
  assert.equal(EXTRACTORS.duration("server:\n  read_timeout: 30s\n", { key: "read_timeout" }), 30000);
});

test("env, json, count, regex", () => {
  assert.equal(EXTRACTORS.env('DEBUG=true\nexport DEBUG="false"\n', { key: "DEBUG" }), "false");
  assert.equal(EXTRACTORS.json('{"a":{"b":[1,{"c":true}]}}', { path: "a.b.1.c" }), true);
  assert.equal(EXTRACTORS.json("not json", { path: "a" }), null);
  assert.equal(EXTRACTORS.count("    role: admin\n    role: admins-readonly\n    role: admin", { pattern: "role:\\s*admin\\s*$" }), 2);
  assert.equal(EXTRACTORS.regex("allow 22\nallow 443", { pattern: "allow (\\d+)" }), "443");
});

test("extractFacts: not set vs documented default; spec validation", () => {
  const specs = [{ name: "protected_mode", extract: "directive", key: "protected-mode", default: "yes (default)" }, { name: "maxmemory_bytes", extract: "size", key: "maxmemory" }];
  assert.deepEqual(extractFacts("port 6379", specs), { protected_mode: "yes (default)", maxmemory_bytes: "not set" });
  assert.deepEqual(factsForFiles({ "a.conf": "maxmemory 2gb" }, { "a.conf": specs.slice(1), "missing.conf": specs }), { "a.conf": { maxmemory_bytes: 2147483648 } });
  assert.deepEqual(checkFactSpecs(specs), []);
  assert.equal(checkFactSpecs([{ name: "x", extract: "magic" }, { name: "y", extract: "count", pattern: "(" }]).length, 2);
});

test("nginx-style terminating semicolons are not part of the value (MiniMax-M3 review)", () => {
  assert.equal(EXTRACTORS.directive("listen 80;\n", { key: "listen" }), "80");
  assert.equal(EXTRACTORS.size("client_max_body_size 10k;\n", { key: "client_max_body_size" }), 10000);
  assert.equal(EXTRACTORS.duration("keepalive_timeout 60s;\n", { key: "keepalive_timeout" }), 60000);
});

test("stripComments removes full-line comments for known formats only; frameEvidence strips on request", async () => {
  const { stripComments, frameEvidence } = await import("../orchestrator.mjs");
  assert.equal(stripComments("redis.conf", "port 0\n# requirepass x\n  # also\ntls-port 6380"), "port 0\ntls-port 6380");
  assert.equal(stripComments("main.tf", "// x\n# y\nresource {}"), "resource {}");
  assert.equal(stripComments("notes.md", "# Title\ntext"), "# Title\ntext", "markdown headings are not comments");
  assert.equal(stripComments("app.env", "A=1 # inline stays"), "A=1 # inline stays");
  assert.equal(frameEvidence({ "a.conf": "# x\ny 1" }, { strip: true }).files["a.conf"], "y 1");
});

test("YAML paths: a nested key of the same name cannot override the real one (R7 injection)", async () => {
  const { yamlPath, checkFactSpecs } = await import("../facts.mjs");
  const yml = "server:\n  port: 8080\n  read_timeout: 30s  # real\n  write_timeout: 10s\noverrides:\n  server:\n    read_timeout: 500ms\nnotes: \"read_timeout: 1ms\"\n";
  assert.equal(yamlPath(yml, "server.read_timeout"), "30s");
  assert.equal(yamlPath(yml, "overrides.server.read_timeout"), "500ms");
  assert.equal(yamlPath(yml, "server.missing"), null);
  assert.equal(EXTRACTORS.duration(yml, { path: "server.read_timeout" }), 30000);
  assert.equal(EXTRACTORS.duration(yml, { key: "read_timeout" }), 500, "the flat key is fooled — which is why YAML requires path");
  assert.equal(checkFactSpecs([{ name: "t", extract: "duration", key: "read_timeout" }], "facts", "service.yaml").length, 1);
  assert.equal(checkFactSpecs([{ name: "t", extract: "duration", path: "server.read_timeout" }], "facts", "service.yaml").length, 0);
  assert.equal(checkFactSpecs([{ name: "t", extract: "duration", key: "read_timeout" }], "facts", "redis.conf").length, 0);
  assert.equal(yamlPath('a:\n  "b": \'x\'\n', "a.b"), "x");
});
