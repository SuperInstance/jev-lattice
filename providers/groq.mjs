#!/usr/bin/env node
/**
 * Groq: fast hosted open-weight models. An independent proof path and a bulk generator.
 *   GROQ_API_KEY=... node providers/groq.mjs [--model id] "prompt"
 * Env: GROQ_API_KEY, GROQ_MODEL, GROQ_TIMEOUT_MS.
 */
import { createOpenAICompatible } from "./openai-compatible.mjs";
import { runCli } from "./cli.mjs";

export const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const GROQ_FAST_MODEL = "llama-3.1-8b-instant";

export function createGroq({ apiKey = globalThis.process?.env?.GROQ_API_KEY, model = globalThis.process?.env?.GROQ_MODEL || GROQ_DEFAULT_MODEL, ...rest } = {}) {
  return createOpenAICompatible({ provider: "groq", keyEnv: "GROQ_API_KEY", apiKey, model, baseUrl: "https://api.groq.com/openai/v1", timeoutMs: Number(globalThis.process?.env?.GROQ_TIMEOUT_MS) || 60000, ...rest });
}

await runCli(import.meta.url, createGroq);
