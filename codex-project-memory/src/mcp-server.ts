import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { MemoryStore } from "./storage.js";
import { resolveProject } from "./repository.js";
import { AUTHORITIES, MEMORY_KINDS } from "./types.js";

const server = new McpServer(
  { name: "project-memory", version: "1.0.0" },
  {
    instructions: "Durable mainline state for long Codex work. Call plan_get and task_get before substantive work; keep the plan revision, exact next action, acceptance state, blockers, and verification current. Current user instructions and repository authority always outrank memory."
  }
);

const cwd = z.string().min(1).optional().describe("Current project working directory. Pass it explicitly for correct project isolation.");
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: { result: value }
});
const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }]
});

function withStore<T>(cwdValue: string | undefined, action: (store: MemoryStore, project: ReturnType<typeof resolveProject>) => T): T {
  const store = new MemoryStore();
  try {
    const project = resolveProject(cwdValue);
    return action(store, project);
  } finally {
    store.close();
  }
}

function tool(name: string, config: any, handler: (args: any) => unknown): void {
  server.registerTool(name, config as any, async (args: any) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return failure(error);
    }
  });
}

tool("status", {
  title: "Project memory status",
  description: "Inspect the resolved project, active task, record counts, database path, and human-readable export directory.",
  inputSchema: { cwd }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd }: { cwd?: string }) => withStore(cwd, (store, project) => store.status(project)));

tool("mainline_get", {
  title: "Get project mainline capsule",
  description: "Read the deterministic goal, plan revision, work item, exact next action, blockers, verification freshness, and Git state.",
  inputSchema: { cwd }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd }: { cwd?: string }) => withStore(cwd, (store, project) => store.mainlineCapsule(project)));

tool("plan_get", {
  title: "Get project plan",
  description: "Read the active plan or an explicit plan id.",
  inputSchema: { cwd, plan_id: z.string().optional() }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd, plan_id }: { cwd?: string; plan_id?: string }) => withStore(cwd, (store, project) => ({ project, plan: store.getPlan(project, plan_id) })));

tool("plan_upsert", {
  title: "Create or update project plan",
  description: "Idempotently update the durable project goal and plan; semantic changes increment its revision.",
  inputSchema: {
    cwd, plan_id: z.string().optional(), title: z.string().max(300).optional(), project_goal: z.string().max(4000).optional(),
    definition_of_done: z.array(z.string().max(1000)).max(50).optional(), current_milestone: z.string().max(1000).nullable().optional(),
    critical_constraints: z.array(z.string().max(1000)).max(50).optional(), open_user_decisions: z.array(z.string().max(1000)).max(50).optional(),
    status: z.enum(["active", "paused", "completed"]).optional(), expected_revision: z.number().int().min(1).optional()
  }, annotations: { readOnlyHint: false, idempotentHint: true }
}, (args: any) => withStore(args.cwd, (store, project) => store.upsertPlan(project, args)));

tool("task_get", {
  title: "Get task state",
  description: "Read the active task for the current branch or an explicit task id. Call this before substantive long-running work.",
  inputSchema: { cwd, task_id: z.string().optional() }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd, task_id }: { cwd?: string; task_id?: string }) => withStore(cwd, (store, project) => ({ project, task: store.getTask(project, task_id) })));

tool("task_upsert", {
  title: "Create or update task state",
  description: "Create or atomically update the compact active-task snapshot. Omitted fields are preserved on updates.",
  inputSchema: {
    cwd, task_id: z.string().optional(), plan_id: z.string().nullable().optional(), title: z.string().max(300).optional(), goal: z.string().max(4000).optional(),
    status: z.enum(["active", "paused", "completed"]).optional(),
    acceptance_criteria: z.array(z.string().max(1000)).max(50).optional(),
    completed_items: z.array(z.string().max(1000)).max(50).optional(),
    next_steps: z.array(z.string().max(1000)).max(50).optional(),
    blockers: z.array(z.string().max(1000)).max(50).optional(),
    notes: z.string().max(4000).nullable().optional(), milestone: z.string().max(1000).nullable().optional(),
    exact_next_action: z.string().max(1000).nullable().optional(), gate_enabled: z.boolean().optional()
  }, annotations: { readOnlyHint: false, idempotentHint: true }
}, (args: any) => withStore(args.cwd, (store, project) => store.upsertTask(project, args)));

tool("task_checkpoint", {
  title: "Checkpoint active task",
  description: "Persist an atomic snapshot of the active task, repository revision, and recent objective tool events before compaction or handoff.",
  inputSchema: { cwd, task_id: z.string().optional(), trigger: z.string().max(100).default("manual") },
  annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, task_id, trigger }: any) => withStore(cwd, (store, project) => store.checkpoint(project, { taskId: task_id, trigger })));

tool("task_complete", {
  title: "Complete active task",
  description: "Mark a task complete only when every acceptance criterion is in completed_items and blockers and next_steps are empty.",
  inputSchema: { cwd, task_id: z.string().optional(), summary: z.string().max(4000).optional() },
  annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, task_id, summary }: any) => withStore(cwd, (store, project) => store.completeTask(project, task_id, summary)));

tool("memory_store", {
  title: "Store durable memory",
  description: "Store a provenance-labelled decision, verified fact, failure, tool quirk, constraint, episodic item, or note. Do not use authoritative labels without authoritative evidence.",
  inputSchema: {
    cwd, task_id: z.string().nullable().optional(), kind: z.enum(MEMORY_KINDS),
    summary: z.string().max(300).optional(), content: z.string().min(1).max(20000), authority: z.enum(AUTHORITIES),
    confidence: z.number().min(0).max(1).optional(), importance: z.number().min(0).max(1).optional(),
    source_note: z.string().max(1000).optional(), file_path: z.string().max(1000).optional(),
    symbol: z.string().max(500).optional(), error_signature: z.string().max(1000).optional(),
    tags: z.array(z.string().max(100)).max(20).optional(), verified: z.boolean().optional(), expires_at: z.string().datetime().optional()
  }, annotations: { readOnlyHint: false, idempotentHint: false }
}, (args: any) => withStore(args.cwd, (store, project) => store.storeMemory(project, args)));

tool("memory_search", {
  title: "Search project memory",
  description: "Search SQLite FTS5 memory with exact path, symbol, error-signature, task, authority, importance, and confidence boosts.",
  inputSchema: {
    cwd, query: z.string().max(5000).default(""), kinds: z.array(z.enum(MEMORY_KINDS)).optional(),
    task_id: z.string().optional(), limit: z.number().int().min(1).max(30).default(8), include_superseded: z.boolean().default(false)
  }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd, query, kinds, task_id, limit, include_superseded }: any) => withStore(cwd, (store, project) => ({
  query, memories: store.search(project, query, { kinds, taskId: task_id, limit, includeSuperseded: include_superseded })
})));

tool("memory_get", {
  title: "Get memory by id",
  description: "Read one project memory record including provenance and supersession metadata.",
  inputSchema: { cwd, memory_id: z.string().min(1) }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd, memory_id }: any) => withStore(cwd, (store, project) => store.getMemory(project, memory_id)));

tool("memory_supersede", {
  title: "Supersede stale memory",
  description: "Create a replacement memory and atomically mark an older active memory superseded, preserving lineage.",
  inputSchema: {
    cwd, memory_id: z.string().min(1), kind: z.enum(MEMORY_KINDS), content: z.string().min(1).max(20000),
    summary: z.string().max(300).optional(), authority: z.enum(AUTHORITIES), source_note: z.string().max(1000).optional(),
    confidence: z.number().min(0).max(1).optional(), importance: z.number().min(0).max(1).optional(),
    file_path: z.string().max(1000).optional(), symbol: z.string().max(500).optional(),
    error_signature: z.string().max(1000).optional(), tags: z.array(z.string().max(100)).max(20).optional(), verified: z.boolean().optional()
  }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, memory_id, ...replacement }: any) => withStore(cwd, (store, project) => store.supersede(project, memory_id, replacement)));

tool("memory_archive", {
  title: "Archive memory",
  description: "Soft-delete a memory from active retrieval without destroying its provenance history.",
  inputSchema: { cwd, memory_id: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
}, ({ cwd, memory_id }: any) => withStore(cwd, (store, project) => store.archiveMemory(project, memory_id)));

tool("verification_record", {
  title: "Record verification evidence",
  description: "Record objective build, test, review, or smoke-test evidence for the active task.",
  inputSchema: {
    cwd, task_id: z.string().optional(), criterion: z.string().max(1000).optional(), command: z.string().max(2000).optional(),
    status: z.enum(["passed", "failed", "skipped"]), evidence: z.string().min(1).max(8000)
  }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, task_id, ...input }: any) => withStore(cwd, (store, project) => store.recordVerification(project, { taskId: task_id, ...input })));

tool("memory_consolidate", {
  title: "Consolidate exact duplicates",
  description: "Preview or archive exact normalized duplicates. This deterministic operation never promotes untrusted memory or invents summaries.",
  inputSchema: { cwd, apply: z.boolean().default(false) }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, apply }: any) => withStore(cwd, (store, project) => store.consolidate(project, apply)));

await server.connect(new StdioServerTransport());
