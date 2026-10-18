export type FactSpec =
  | { name: string; extract: "directive" | "size" | "duration" | "env"; key: string; default?: unknown }
  | { name: string; extract: "json"; path: string; default?: unknown }
  | { name: string; extract: "count" | "regex"; pattern: string; flags?: string; default?: unknown };
export const EXTRACTORS: Record<FactSpec["extract"], (text: string, spec: any) => unknown>;
export function parseSize(v: string): number | null;
export function parseDuration(v: string): number | null;
export function checkFactSpecs(specs: unknown, where?: string): string[];
export function extractFacts(text: string, specs: FactSpec[]): Record<string, unknown>;
export function factsForFiles(files: Record<string, string>, specsByFile?: Record<string, FactSpec[]>): Record<string, Record<string, unknown>>;
