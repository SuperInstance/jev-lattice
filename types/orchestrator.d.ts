import type { JEVLattice, GateResult, Proof, Verdict } from "./jev-core.js";
type Jev = { nouls(state: unknown, items: { key: string; instructions: string }[]): Promise<Record<string, any>>; noul(state: unknown, instructions: string, criteria?: unknown): Promise<any> };
export function questionText(n: { text: string; question_spec?: unknown }): string;
export function verifyWithJev(l: JEVLattice, nodeId: string, o: { jev: Jev; state?: unknown; instructions?: string; criteria?: unknown; channel?: string | null }): Promise<{ ok: true; p: number; model: string; cached: boolean; state_hash: string; proof: Proof; gate: GateResult; latency_ms?: number }>;
export function verifyOpenGates(l: JEVLattice, o: { jev: Jev; state?: unknown; ids?: string[] | null; limit?: number; channel?: string | null }): Promise<{ ok: true; verified: number; state_hash?: string; cache?: unknown; results: { id: string; text: string; p: number; verdict: Verdict; go: boolean }[] }>;
export function invalidateStale(l: JEVLattice, o: { state: unknown; channel?: string | null; reason?: string }): Promise<{ ok: true; state_hash: string; invalidated: number; kept: number; reopened: string[] }>;
export function verifyFiles(l: JEVLattice, o: { jev: Jev; files: Record<string, string>; ids?: string[] | null; rules?: string | null; limit?: number }): Promise<{ ok: true; verified: number; calls: number; cacheHits: number; groups: number; results: { id: string; text: string; p: number; verdict: Verdict; reads: string[] }[] }>;
export function invalidateChangedFiles(l: JEVLattice, o: { files: Record<string, string>; reason?: string }): Promise<{ ok: true; invalidated: number; kept: number; changedFiles: string[] }>;
export function firmUp(l: JEVLattice, o: { secondPath: (l: JEVLattice, nodeId: string) => Promise<unknown>; ids?: string[] | null }): Promise<{ ok: true; [k: string]: unknown }>;
export function latticeState(l: JEVLattice, nodeId: string, o?: { topK?: number }): unknown;
// Beta: LLM-driven helpers (shape may change before 1.0)
export function proveWithLLM(l: JEVLattice, nodeId: string, o: Record<string, unknown>): Promise<any>;
export function proveWithMiniMax(l: JEVLattice, nodeId: string, o: { mm: unknown; state?: unknown }): Promise<any>;
export function decompose(l: JEVLattice, nodeId: string, o: { mm: unknown; maxSub?: number; threshold?: number }): Promise<any>;
export function rollup(l: JEVLattice, parentId: string): any;
export function compile(l: JEVLattice, nodeId: string, o: Record<string, unknown>): Promise<any>;
export const MINIMAX_COST_WEIGHT: number;
export const ROLLUP_COST_WEIGHT: number;
