import test from "node:test";
import assert from "node:assert/strict";
import { createGroq } from "../providers/groq.mjs";

const reply = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });

test("groq: chat, JSON mode, retry on 429 with retry-after, usage", async () => {
  const calls = [];
  const seq = [reply(429, {}, { "retry-after": "0.01" }), reply(200, { model: "llama-x", choices: [{ message: { content: '{"ok": true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })];
  const g = createGroq({ apiKey: "k", fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return seq.shift(); } });
  const r = await g.json("give json");
  assert.deepEqual(r.value, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.response_format.type, "json_object");
  assert.match(calls[1].url, /\/chat\/completions$/);
  assert.equal(g.usage.calls, 1);
  assert.equal(g.usage.completion_tokens, 3);
});

test("groq: a 4xx is a non-retried error with the API's message", async () => {
  const g = createGroq({ apiKey: "k", fetchImpl: async () => reply(401, { error: { message: "Invalid API Key", code: "invalid_api_key" } }) });
  await assert.rejects(g.chat("x"), e => e.status === 401 && e.code === "invalid_api_key");
  assert.throws(() => createGroq({ apiKey: "" }), /GROQ_API_KEY/);
});

test("deepseek: prefix-cache accounting and cache-friendly message order", async () => {
  const { createDeepSeek } = await import("../providers/deepseek.mjs");
  const bodies = [];
  const d = createDeepSeek({ apiKey: "k", fetchImpl: async (url, init) => { bodies.push({ url, body: JSON.parse(init.body) }); return reply(200, { model: "deepseek-flash", choices: [{ message: { content: "ok", reasoning_content: "r" } }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 } }); } });
  const r = await d.withPrefix("STABLE INSTRUCTIONS", "varying part");
  assert.equal(r.reasoning, "r");
  assert.deepEqual(bodies[0].body.messages.map(m => m.content), ["STABLE INSTRUCTIONS", "varying part"]);
  assert.match(bodies[0].url, /api\.deepseek\.com\/v1\/chat\/completions$/);
  assert.equal(d.usage.cache_hit_tokens, 90);
  assert.equal(d.provider, "deepseek");
});
