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

export interface ProjectContext {
  id: string;
  root: string;
  name: string;
  remote: string | null;
  gitCommonDir: string | null;
  branch: string | null;
  revision: string | null;
}

export interface TaskRecord {
  id: string;
  project_id: string;
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
