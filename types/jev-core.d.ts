// Stable API (semver from 1.0): the lattice, proofs and the gate. See docs/GATE-SEMANTICS.md.

export type EvaluationMode = "BINARY" | "COORDINATED";
export type Verdict = "GO" | "OPEN" | "REFUTED" | "CONFLICT";
export type NodeType = "OBSERVATION" | "QUESTION";

export interface QuestionSpec {
  evaluation_mode?: EvaluationMode;
  required_independent_proofs?: number;
  confidence_threshold?: number;
  max_proof_age_ms?: number | null;
  allowed_sources?: string[] | null;
  blocked_sources?: string[] | null;
  source_thresholds?: Record<string, number> | null;
  block_on_conflict?: boolean;
  reads?: string[] | null;
  fragility_band?: number;
  require_firm?: boolean;
  intent?: string | null;
  /** for verifiers: what to look at (sent as structured instructions) */
  focus?: string | null;
  /** for verifiers: TypeSafe Noul criteria */
  criteria?: { true?: unknown; false?: unknown } | null;
}

export interface ProofInput {
  proof_id?: string;
  source_type?: string;
  confidence?: number;
  cost_weight?: number;
  timestamp?: string;
  note?: string;
  provider?: string;
  model?: string;
  independence_key?: string;
  evidence?: { state_hash?: string; channel?: string; spread?: number; file_hashes?: Record<string, string>; [k: string]: unknown };
  invalidated?: boolean;
}

export type Proof = ProofInput & Required<Pick<ProofInput, "proof_id" | "source_type" | "confidence" | "cost_weight" | "timestamp">> & {
  invalidated_reason?: string;
  invalidated_at?: string;
};

export interface LatticeNode {
  id: string;
  node_type: NodeType;
  text: string;
  tags: string[];
  spatial_coordinate: number[];
  embedding: number[];
  transition_probabilities: { target: string; probability: number; tags?: string[] }[];
  epistemic_uncertainty: number;
  salience_score: number;
  access_frequency: number;
  last_consolidated: string | null;
  created_at: string;
  hierarchical_links: { parent_node: string | null; child_nodes: string[] };
  question_spec: Required<QuestionSpec> | null;
  active_proofs: Proof[];
}

export interface GateResult {
  ok: boolean;
  go: boolean;
  gated: boolean;
  open: boolean;
  verdict: Verdict;
  mode: EvaluationMode;
  required: number;
  threshold: number;
  validProofs: number;
  refutingProofs: number;
  paths: number;
  liveProofs: number;
  ignoredProofs: number;
  bestConfidence: number;
  proofSources: string[];
  multiProofSalience: number;
  margin: number | null;
  fragile: boolean;
  reason: string;
  needs_corroboration?: boolean;
  held?: Verdict;
  error?: string;
}

export interface LatticeState {
  schema?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
  nodes: Partial<LatticeNode>[];
}

export type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string };

export class JEVLattice {
  nodes: Map<string, LatticeNode>;
  version: number;
  ingest(o: { text: string; tags?: string[]; linkToNearest?: boolean; node_type?: NodeType | null; question_spec?: QuestionSpec | null; active_proofs?: ProofInput[] | null; proof?: ProofInput | null }): Result<{ node: LatticeNode }>;
  addProof(nodeId: string, proof: ProofInput): Result<{ node: LatticeNode; proof: Proof; proofCount: number }>;
  invalidateProof(nodeId: string, proofId: string, reason?: string | null): Result<{ node: LatticeNode; gate: GateResult }>;
  evaluateGoNoGo(nodeId: string, opts?: { now?: number }): GateResult;
  getNode(id: string): LatticeNode | null;
  listNodes(): LatticeNode[];
  query(o: { text: string; tags?: string[]; topK?: number; beam?: number }): { ok: boolean; results: unknown[]; [k: string]: unknown };
  consolidate(o?: Record<string, unknown>): { ok: boolean; seekingVerification: number; [k: string]: unknown };
  boost(id: string, delta?: number): Result<{ node: LatticeNode }>;
  prune(id: string): Result<{ removed?: string }>;
  exportState(): LatticeState & { schema: string };
  importState(state: LatticeState): Result<{ nodes: number }>;
  stats(): { ok: true; nodes: number; questions: number; openGates: number; edges: number; avgSalience: number; [k: string]: unknown };
}

export const SCHEMA: string;
export function normalizeProof(p: ProofInput): Proof;
export function normalizeQuestionSpec(s: QuestionSpec | null | undefined): Required<QuestionSpec>;
export function independenceKey(p: ProofInput): string;
export function createToolRegistry(lattice: JEVLattice): Record<string, (args?: any) => unknown>;
