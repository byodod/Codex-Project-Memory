export const ROLE_KINDS = ["governance", "owner", "worker"] as const;
export const GENERATION_STATUSES = ["bootstrapping", "active", "retired", "rejected"] as const;
export const MESSAGE_TYPES = [
  "ASSIGN", "QUESTION", "ANSWER", "PROPOSAL", "DECISION_REQUEST",
  "DECISION", "HANDOFF", "VERIFY_REQUEST", "RESULT", "BLOCKED"
] as const;
export const FACT_KINDS = [
  "charter", "ownership", "architecture", "decision", "task_state",
  "open_question", "failure", "invariant", "dependency", "artifact"
] as const;

export type RoleKind = (typeof ROLE_KINDS)[number];
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];
export type MessageType = (typeof MESSAGE_TYPES)[number];
export type FactKind = (typeof FACT_KINDS)[number];
export type RotationState = "ROTATION_PENDING" | "DRAINING" | "CHECKPOINTING" | "VALIDATING" | "BOOTSTRAPPING" | "CUTOVER" | "COMPLETED" | "FAILED";

export interface ProjectContext {
  id: string;
  root: string;
  name: string;
  remote: string | null;
  gitCommonDir: string | null;
  branch: string | null;
  revision: string | null;
}

export interface RolePolicy {
  mode: "read_only" | "workspace_write";
  deniedTools: string[];
  allowedWriteGlobs: string[];
  canDelegateTo: string[];
  freshVerification: boolean;
}

export interface RoleRecord {
  id: string;
  project_id: string;
  role_key: string;
  name: string;
  kind: RoleKind;
  mission: string;
  owned_domains: string[];
  excluded_domains: string[];
  escalation_rules: string[];
  policy: RolePolicy;
  created_at: string;
  updated_at: string;
}

export interface GenerationRecord {
  id: string;
  role_id: string;
  generation_number: number;
  thread_id: string;
  status: GenerationStatus;
  health: "healthy" | "aging" | "rotation_required" | "retired" | "rejected";
  architecture_epoch: number;
  turn_count: number;
  compact_count: number;
  token_usage: number;
  bootstrap_hash: string | null;
  retirement_reason: string | null;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string | null;
}

export interface HookInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model?: string;
  permission_mode?: string;
  turn_id?: string;
  source?: string;
  trigger?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  reason?: string;
}

export interface BootstrapResponse {
  role_id: string;
  mission: string;
  owned_domains: string[];
  critical_invariants: string[];
  open_questions: string[];
  architecture_epoch: number;
}
