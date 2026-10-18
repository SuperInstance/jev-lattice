import type { ProofInput } from "./jev-core.js";
export const JEV_DEFAULT_MODEL: string;
export interface NoulItem { key: string; instructions: string; criteria?: unknown }
export interface JevClient {
  model: string;
  provider: "typesafe";
  longContext: boolean;
  usage: Record<string, number>;
  ask(state: unknown, questions: Record<string, { type: "noul" | "choice" | "score"; instructions: string; criteria?: unknown }>, opts?: { model?: string }): Promise<{ answers: Record<string, any>; model: string; usage?: unknown }>;
  noul(state: unknown, instructions: string, criteria?: unknown): Promise<{ p: number; model: string; latency_ms?: number; cached?: boolean; spread?: number; state_hash?: string }>;
  nouls(state: unknown, items: NoulItem[]): Promise<Record<string, any>>;
  choice(state: unknown, instructions: string, criteria: Record<string, string>): Promise<{ choice: string; confidence: number; probabilities: Record<string, number>; model: string }>;
  score(state: unknown, instructions: string, criteria: Record<string, string>): Promise<{ score: number; confidence: number; probabilities: Record<string, number>; model: string }>;
  models(): Promise<unknown>;
}
/** model defaults to $JEV_MODEL, else jev-latest; pin a version in production. */
export function createJev(o?: { apiKey?: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch; maxRetries?: number; timeoutMs?: number; longContext?: boolean }): JevClient;
export function noulToProof(res: { p: number; model?: string; spread?: number; latency_ms?: number; cached?: boolean }, o?: { note?: string | null; instructions?: string; state_hash?: string | null; channel?: string | null }): ProofInput;
export function choiceToProof(answer: { probabilities?: Record<string, number>; choice?: string; confidence?: number }, allowed: string[], o?: { model?: string; note?: string | null; state_hash?: string | null; channel?: string | null }): ProofInput;
export function scoreToProof(answer: { probabilities?: Record<string, number>; score?: number; confidence?: number }, minLevel: number, o?: { model?: string; note?: string | null; state_hash?: string | null; channel?: string | null }): ProofInput;
