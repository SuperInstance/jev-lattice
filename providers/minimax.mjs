#!/usr/bin/env node
/**
 * MiniMax provider — cheap, high-volume LLM for discovery work:
 * decomposing questions, drafting chain-of-thought proofs, reviewing code.
 *
 * Works in Node >=18, browsers, and Cloudflare Workers (fetch only).
 *
 * CLI:
 *   MINIMAX_TOKEN=... node providers/minimax.mjs [--model MiniMax-M3] [--system "..."] "prompt" [file ...]
 *   Files are appended to the prompt; stdin is used when no prompt is given.
 */

export const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";
export const MINIMAX_FAST_MODEL = "MiniMax-M2.7-highspeed";
const DEFAULT_BASE = "https://api.minimax.io/v1";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Remove <think>…</think> blocks some MiniMax models inline in content. */
export function stripThinking(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Pull the first JSON object/array out of model text (tolerates ```json fences). */
export function extractJson(text) {
  const t = stripThinking(text);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found in model output");
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in model output");
}

export function createMiniMax({
  apiKey = globalThis.process?.env?.MINIMAX_TOKEN,
  model = MINIMAX_DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE,
  fetchImpl = globalThis.fetch,
  maxRetries = 3,
  timeoutMs = 180000
} = {}) {
  if (!apiKey) throw new Error("MiniMax: missing api key (MINIMAX_TOKEN)");
  const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };

  async function chat(messages, { model: m = model, maxTokens = 4096, temperature = 0.3 } = {}) {
    if (typeof messages === "string") messages = [{ role: "user", content: messages }];
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetchImpl(`${baseUrl}/text/chatcompletion_v2`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: m, messages, max_tokens: maxTokens, temperature }),
          signal: ctrl.signal
        }).finally(() => clearTimeout(timer));
        const data = await res.json().catch(() => ({}));
        const code = data?.base_resp?.status_code;
        // 1002 = rate limited, 1000/1001/1024/1033 = transient server errors
        if (res.status === 429 || res.status >= 500 || [1000, 1001, 1002, 1024, 1033].includes(code)) {
          lastErr = new Error(`MiniMax transient ${res.status}/${code}: ${data?.base_resp?.status_msg || ""}`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok || (code && code !== 0)) {
          throw new Error(`MiniMax error ${res.status}/${code}: ${data?.base_resp?.status_msg || JSON.stringify(data).slice(0, 300)}`);
        }
        const msg = data.choices?.[0]?.message || {};
        usage.calls++;
        usage.prompt_tokens += data.usage?.prompt_tokens || 0;
        usage.completion_tokens += data.usage?.completion_tokens || 0;
        return {
          text: stripThinking(msg.content),
          reasoning: msg.reasoning_content || null,
          model: data.model || m,
          usage: data.usage || null,
          finish_reason: data.choices?.[0]?.finish_reason
        };
      } catch (e) {
        lastErr = e;
        if (e.name !== "AbortError" && !/transient|fetch failed/i.test(e.message)) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  /** Ask for JSON; retries once with the parse error fed back. */
  async function json(prompt, opts = {}) {
    const messages = [
      { role: "system", content: opts.system || "You output only valid JSON. No prose, no code fences." },
      { role: "user", content: prompt }
    ];
    const first = await chat(messages, opts);
    try {
      return { value: extractJson(first.text), raw: first };
    } catch (e) {
      messages.push({ role: "assistant", content: first.text }, { role: "user", content: `That was not parseable JSON (${e.message}). Reply again with only the JSON.` });
      const second = await chat(messages, opts);
      return { value: extractJson(second.text), raw: second };
    }
  }

  return { chat, json, usage, model, provider: "minimax" };
}

// ---------- CLI ----------
const isMain = globalThis.process?.argv?.[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { readFileSync } = await import("node:fs");
  const args = process.argv.slice(2);
  let model, system, prompt;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--system") system = args[++i];
    else if (prompt === undefined) prompt = args[i];
    else files.push(args[i]);
  }
  if (prompt === undefined) prompt = readFileSync(0, "utf8");
  for (const f of files) prompt += `\n\n----- FILE: ${f} -----\n${readFileSync(f, "utf8")}`;
  const mm = createMiniMax({ model });
  const messages = system ? [{ role: "system", content: system }, { role: "user", content: prompt }] : prompt;
  const out = await mm.chat(messages, { maxTokens: Number(process.env.MINIMAX_MAX_TOKENS) || 40000 });
  if (!out.text && out.finish_reason === "length") {
    process.stderr.write("[minimax] reasoning consumed the whole token budget; raise MINIMAX_MAX_TOKENS or use a -highspeed model\n");
    process.exitCode = 1;
  }
  process.stdout.write(out.text + "\n");
  process.stderr.write(`[minimax] ${out.model} usage=${JSON.stringify(out.usage)}\n`);
}
