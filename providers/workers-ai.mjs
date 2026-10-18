/**
 * Cloudflare Workers AI provider — an on-edge small model as a third,
 * independent proof path (source_type SMALL_MODEL). Needs an `AI` binding,
 * so it only runs inside a Worker / Durable Object.
 */
import { extractJson } from "./minimax.mjs";

export const WORKERS_AI_DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
export const WORKERS_AI_COST_WEIGHT = 0.15;

export function createWorkersAI(ai, { model = WORKERS_AI_DEFAULT_MODEL } = {}) {
  if (!ai?.run) throw new Error("Workers AI binding missing");
  async function chat(messages, { maxTokens = 512, temperature = 0.1 } = {}) {
    if (typeof messages === "string") messages = [{ role: "user", content: messages }];
    const out = await ai.run(model, { messages, max_tokens: maxTokens, temperature });
    const text = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
    return { text, model, usage: out?.usage || null };
  }
  async function json(prompt, opts = {}) {
    const raw = await chat([
      { role: "system", content: "You output only valid JSON. No prose, no code fences." },
      { role: "user", content: prompt }
    ], { maxTokens: Math.min(opts.maxTokens || 512, 1024), temperature: opts.temperature });
    return { value: extractJson(raw.text), raw };
  }
  return { chat, json, model, provider: "workers-ai" };
}
