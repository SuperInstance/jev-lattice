import type { JEVLattice } from "./jev-core.js";
export const SERVER_INFO: { name: string; version: string };
export const PROTOCOL_VERSIONS: string[];
export const PROFILES: Record<"gatekeeper" | "reader", string[]>;
export interface ToolDef { name: string; description: string; inputSchema: object }
export interface RequestContext {
  /** true to allow, or a reason string to refuse */
  allow?: (tool: string) => true | string;
  /** null to allow, or a reason string to refuse (quotas) */
  guard?: (tool: string, args: any) => null | string | Promise<null | string>;
  profile?: keyof typeof PROFILES | null;
}
export function isMutating(tool: string): boolean;
export function validateArgs(schema: object, value: unknown, path?: string): string[];
export function toolDefs(o?: { hasJev?: boolean; hasMiniMax?: boolean; hasCapacity?: boolean; hasSmall?: boolean; hasPredicates?: boolean; hasSenses?: boolean }): ToolDef[];
export function createMcp(o: {
  lattice: JEVLattice; jev?: object | null; mm?: object | null; small?: object | null; predicates?: object | null; senses?: object | null; capacity?: object | null;
  consolidateOpts?: () => object; persist?: (() => unknown) | null; profile?: keyof typeof PROFILES | null;
  extraTools?: { def: ToolDef; handler: (args: any) => unknown; mutating?: boolean }[];
}): {
  handle(msg: { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any }, ctx?: RequestContext): Promise<any>;
  callTool(name: string, args?: any): Promise<any>;
  defs: ToolDef[];
  visible(ctx?: RequestContext): ToolDef[];
};
