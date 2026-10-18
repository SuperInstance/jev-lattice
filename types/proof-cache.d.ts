export interface CacheStore {
  get(key: string): Promise<any>;
  getMany?(keys: string[]): Promise<Map<string, any>>;
  set(key: string, value: any): Promise<void>;
  setMany?(entries: [string, any][]): Promise<void>;
}
export interface ProofCache {
  ttlMs: number | null;
  stats: { hits: number; misses: number; [k: string]: number };
  keyFor(o: { provider: string; model: string; state_hash: string; instructions: string; criteria?: unknown }): Promise<string>;
  [k: string]: unknown;
}
export function canonicalize(v: unknown): string;
export function sha256Hex(s: string): Promise<string>;
export function stateHash(state: unknown, opts?: { canonical?: boolean }): Promise<string>;
export function memoryStore(): CacheStore;
export function durableObjectStore(storage: unknown, prefix?: string): CacheStore;
export function createProofCache(o?: { store?: CacheStore; ttlMs?: number | null; now?: () => number }): ProofCache;
export function cachedJev<J extends object>(jev: J, cache: ProofCache, opts?: { canonicalState?: boolean }): J & { cache: ProofCache };
export function stabilityProbe(jev: object, state: unknown, items: { key: string; instructions: string }[], opts?: { n?: number; cache?: ProofCache | null; canonicalState?: boolean }): Promise<Record<string, { spread: number; ps: number[] }>>;
