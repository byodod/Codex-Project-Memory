export const MEMORY_KINDS = [
  "decision",
  "project_fact",
  "failure",
  "tool_quirk",
  "constraint",
  "episodic",
  "note"
] as const;

export const AUTHORITIES = [
  "user_decision",
  "project_authority",
  "agent_inference",
  "tool_observation",
  "external_evidence",
  "historical_attempt"
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type Authority = (typeof AUTHORITIES)[number];
export type TaskStatus = "active" | "paused" | "completed";
export type PlanStatus = "active" | "paused" | "completed";
export type RepositoryState = "clean" | "dirty" | "unknown";
export type VerificationFreshness = "CURRENT" | "STALE" | "NONE_CURRENT" | "UNKNOWN";

export interface ProjectContext {
  id: string;
  root: string;
  name: string;
  remote: string | null;
  gitCommonDir: string | null;
  branch: string | null;
  revision: string | null;
  repositoryState: RepositoryState;
  workspaceDigest: string | null;
}

export interface PlanRecord {
  id: string;
  project_id: string;
  title: string;
  project_goal: string;
  definition_of_done: string[];
  revision: number;
  current_milestone: string | null;
  critical_constraints: string[];
  open_user_decisions: string[];
  status: PlanStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskRecord {
  id: string;
  project_id: string;
  plan_id: string | null;
  plan_revision: number | null;
  title: string;
  goal: string;
  status: TaskStatus;
  branch: string | null;
  base_revision: string | null;
  acceptance_criteria: string[];
  completed_items: string[];
  next_steps: string[];
  blockers: string[];
  notes: string | null;
  milestone: string | null;
  exact_next_action: string | null;
  version: number;
  gate_enabled: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MemoryRecord {
  id: string;
  project_id: string;
  task_id: string | null;
  kind: MemoryKind;
  summary: string;
  content: string;
  authority: Authority;
  confidence: number;
  importance: number;
  status: "active" | "superseded" | "archived";
  source_note: string | null;
  file_path: string | null;
  symbol: string | null;
  error_signature: string | null;
  tags: string[];
  superseded_by: string | null;
  recall_count: number;
  last_recalled_at?: string | null;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  expires_at: string | null;
  score?: number;
  rank?: number;
}

export interface VerificationRecord {
  id: string;
  project_id: string;
  task_id: string;
  criterion: string | null;
  command: string | null;
  status: "passed" | "failed" | "skipped";
  evidence: string;
  revision: string | null;
  plan_revision: number | null;
  task_version: number;
  workspace_digest: string | null;
  created_at: string;
  freshness?: VerificationFreshness;
}

export interface MainlineCapsule {
  capsule_schema_version: 2;
  recovery_mode: "full" | "degraded";
  project: {
    id: string;
    name: string;
    root: string;
  };
  project_goal: string;
  definition_of_done: string[] | "NONE" | "UNKNOWN";
  active_plan: {
    id: string;
    revision: number;
    status: PlanStatus;
  } | "UNKNOWN";
  current_milestone: string;
  active_work_item: {
    id: string;
    version: number;
    plan_revision: number | null;
    title: string;
    goal: string;
    acceptance_criteria: string[];
    completed_items: string[];
  } | "UNKNOWN";
  exact_next_action: string;
  blockers: string[] | "NONE" | "UNKNOWN";
  critical_constraints: string[] | "NONE" | "UNKNOWN";
  open_user_decisions: string[] | "NONE" | "UNKNOWN";
  latest_valid_verification: {
    freshness: VerificationFreshness;
    status: "passed" | "failed" | "skipped" | "UNKNOWN";
    command_or_criterion: string;
    evidence: string;
    created_at: string | null;
  };
  repository: {
    branch: string;
    revision: string;
    state: RepositoryState;
    workspace_digest: string;
  };
  recent_failed_approach: string;
  checkpoint: {
    id: string;
    created_at: string;
  } | "NONE";
  degraded_reason?: string;
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
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  reason?: string;
}
