import type { Verdict } from "./jev-core.js";
export interface GateConfig {
  rules?: string;
  threshold?: number;
  gates: { id: string; question: string; reads: string[]; spec?: import("./jev-core.js").QuestionSpec; focus?: string; criteria?: { true?: unknown; false?: unknown } }[];
  facts?: Record<string, import("./facts.js").FactSpec[]>;
  quarantine?: boolean;
  /** default true */
  strip_comments?: boolean;
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
export function lintGates(o: { cfg: GateConfig; jev?: object | null }): Promise<{ ok: boolean; findings: { gate: string; level: "error" | "warn" | "info"; issue: string; p?: number }[] }>;
export function formatResult(run: GateRun, format?: "text" | "json" | "markdown"): string;
