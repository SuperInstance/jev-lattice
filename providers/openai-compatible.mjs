/**
 * OpenAI-compatible chat providers (Groq, DeepSeek, …) with the same {chat, json} shape as
 * providers/minimax.mjs, so any helper that takes `mm` takes these. Fetch only.
 */
import { extractJson } from "./minimax.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createOpenAICompatible({
  provider,
  apiKey,
  model,
  baseUrl,
  fetchImpl = globalThis.fetch,
  maxRetries = 4,
  timeoutMs = 60000,
  keyEnv = "API_KEY"
} = {}) {
  if (!apiKey) throw new Error(`${provider}: missing api key (${keyEnv})`);
  const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };

  async function chat(messages, { model: m = model, maxTokens = 2048, temperature = 0.2, jsonMode = false } = {}) {
    if (typeof messages === "string") messages = [{ role: "user", content: messages }];
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: m, messages, max_tokens: maxTokens, temperature, ...(jsonMode ? { response_format: { type: "json_object" } } : {}) }),
          signal: ctrl.signal
        });
      } catch (e) {
        lastErr = e.name === "AbortError" ? new Error(`${provider} request exceeded ${timeoutMs} ms`) : e;
        await sleep(500 * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }
      // 429: Groq sends retry-after (seconds); 5xx/503: transient
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get?.("retry-after"));
        lastErr = new Error(`${provider} transient ${res.status}`);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`${provider} error ${res.status}: ${JSON.stringify(data?.error || data).slice(0, 300)}`), { status: res.status, code: data?.error?.code });
      usage.calls++;
      usage.prompt_tokens += data.usage?.prompt_tokens || 0;
      usage.completion_tokens += data.usage?.completion_tokens || 0;
      // DeepSeek context caching: a repeated prompt PREFIX is billed at the cache-hit rate
      usage.cache_hit_tokens += data.usage?.prompt_cache_hit_tokens || 0;
      usage.cache_miss_tokens += data.usage?.prompt_cache_miss_tokens || 0;
      const msg = data.choices?.[0]?.message || {};
      return { text: msg.content || "", reasoning: msg.reasoning_content || null, model: data.model || m, usage: data.usage || null, finish_reason: data.choices?.[0]?.finish_reason };
    }
    throw lastErr;
  }

  /** Ask for JSON (Groq JSON mode); one retry with the parse error fed back. */
  async function json(prompt, opts = {}) {
    const messages = [{ role: "system", content: opts.system || "You output only valid JSON. No prose, no code fences." }, { role: "user", content: prompt }];
    const first = await chat(messages, { ...opts, jsonMode: true });
    try {
      return { value: extractJson(first.text), raw: first };
    } catch (e) {
      messages.push({ role: "assistant", content: first.text }, { role: "user", content: `That was not parseable JSON (${e.message}). Reply again with only the JSON.` });
      const second = await chat(messages, { ...opts, jsonMode: true });
      return { value: extractJson(second.text), raw: second };
    }
  }

  async function models() {
    const res = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return res.json();
  }

    /**
   * Cache-friendly call: a stable `prefix` (instructions, shared context, examples) first and
   * the varying part last, so providers with prefix caching (DeepSeek) bill the prefix at the
   * cache-hit rate on every call after the first.
   */
  function withPrefix(prefix, suffix, opts) {
    return chat([{ role: "system", content: prefix }, { role: "user", content: suffix }], opts);
  }

  return { chat, json, withPrefix, models, usage, model, provider };
}

