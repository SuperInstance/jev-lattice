import type { Verdict } from "./jev-core.js";
export interface GateConfig {
  rules?: string;
  threshold?: number;
  gates: { id: string; question: string; reads: string[]; spec?: import("./jev-core.js").QuestionSpec }[];
}
export interface GateRun {
  pass: boolean;
  results: { id: string; question: string; verdict: Verdict; go: boolean; margin: number | null; fragile: boolean; reason: string }[];
  missing: string[];
  verifierError: string | null;
  drift: string[];
  verified: number;
}
export function loadConfig(file: string): { cfg: GateConfig; errors: string[] };
export function runGate(o: { cfg: GateConfig; root?: string; statePath?: string | null; jev?: object | null }): Promise<GateRun>;
export function formatResult(run: GateRun, format?: "text" | "json" | "markdown"): string;
