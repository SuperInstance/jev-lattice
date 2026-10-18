#!/usr/bin/env node
/**
 * DeepSeek: cheap long-output model with automatic prefix (context) caching. Put stable text
 * first (`withPrefix(prefix, suffix)`): repeated prefixes are billed at the cache-hit rate, and
 * `usage.cache_hit_tokens` / `cache_miss_tokens` show how well a workload reuses its prefix.
 *   DEEPSEEK_API_KEY=... node providers/deepseek.mjs [--model id] "prompt"
 * Env: DEEPSEEK_API_KEY, DEEPSEEK_MODEL (default deepseek-flash), DEEPSEEK_TIMEOUT_MS.
 */
import { createOpenAICompatible } from "./openai-compatible.mjs";
import { runCli } from "./cli.mjs";

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

export function createDeepSeek({ apiKey = globalThis.process?.env?.DEEPSEEK_API_KEY, model = globalThis.process?.env?.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL, ...rest } = {}) {
  return createOpenAICompatible({ provider: "deepseek", keyEnv: "DEEPSEEK_API_KEY", apiKey, model, baseUrl: "https://api.deepseek.com/v1", timeoutMs: Number(globalThis.process?.env?.DEEPSEEK_TIMEOUT_MS) || 180000, ...rest });
}

await runCli(import.meta.url, createDeepSeek);
