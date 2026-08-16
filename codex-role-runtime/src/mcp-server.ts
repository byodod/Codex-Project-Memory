import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveProject } from "./project.js";
import { dispatchLiaisonRequest, dispatchRoleMessage, startRoleGeneration } from "./generation-service.js";
import { RoleStore } from "./store.js";
import { initializeStandardTopology } from "./topology.js";
import { FACT_KINDS, MESSAGE_TYPES, ROLE_KINDS } from "./types.js";

const server = new McpServer({ name: "codex-role-runtime", version: "1.0.0" });
const cwd = z.string().min(1).optional().describe("Current project working directory; pass explicitly for project isolation.");

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value as any } };
}
function run<T>(workingDirectory: string | undefined, action: (store: RoleStore, project: ReturnType<typeof resolveProject>) => T) {
  const store = new RoleStore();
  try { return result(action(store, resolveProject(workingDirectory || process.cwd()))); } finally { store.close(); }
}
async function runAsync<T>(workingDirectory: string | undefined, action: (store: RoleStore, project: ReturnType<typeof resolveProject>) => Promise<T>) {
  const store = new RoleStore();
  try { return result(await action(store, resolveProject(workingDirectory || process.cwd()))); } finally { store.close(); }
}
function tool(name: string, config: any, callback: any): void {
  server.registerTool(name, {
    ...config,
    description: `Persistent Role / Disposable Session control plane for Codex. ${config.description}`
  }, callback);
}

tool("status", {
  title: "Role runtime status", description: "List project epoch, roles, active generations, health, open tasks, and mailbox counts.",
  inputSchema: { cwd }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd }: any) => run(cwd, (store, project) => store.status(project)));

tool("project_configure", {
  title: "Configure project constitution", description: "Set the small L0 project constitution shared by every persistent role.",
  inputSchema: { cwd, constitution: z.string().max(12000) }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, constitution }: any) => run(cwd, (store, project) => store.configureProject(project, constitution)));

tool("project_initialize", {
  title: "Initialize standard role orchestration", description: "Idempotently create the User Liaison, Coordinator, Architect, and Verifier topology. Hook-based initialization also binds the current task to the User Liaison.",
  inputSchema: { cwd, constitution: z.string().max(12000).optional() }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, constitution }: any) => run(cwd, (store, project) => initializeStandardTopology(store, project, constitution)));

tool("role_define", {
  title: "Define persistent role", description: "Create or update a durable role charter, semantic ownership, escalation rules, and enforcement policy.",
  inputSchema: {
    cwd, role_key: z.string().min(1).max(64), name: z.string().max(200).optional(), kind: z.enum(ROLE_KINDS).default("owner"),
    mission: z.string().min(1).max(4000), owned_domains: z.array(z.string()).max(100).default([]),
    excluded_domains: z.array(z.string()).max(100).default([]), escalation_rules: z.array(z.string()).max(100).default([]),
    policy: z.object({
      mode: z.enum(["read_only", "workspace_write"]).optional(), deniedTools: z.array(z.string()).max(100).optional(),
      allowedWriteGlobs: z.array(z.string()).max(100).optional(), canDelegateTo: z.array(z.string()).max(100).optional(),
      freshVerification: z.boolean().optional()
    }).optional()
  }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, ...input }: any) => run(cwd, (store, project) => store.defineRole(project, input)));

tool("role_list", {
  title: "List persistent roles", description: "Read role charters, active generations, health, and pending message counts.",
  inputSchema: { cwd }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd }: any) => run(cwd, (store, project) => store.listRoles(project)));

tool("role_bind", {
  title: "Bind initial role generation", description: "Bind an unowned thread to a role that has no active generation. Thread-role identity is immutable.",
  inputSchema: { cwd, role_key: z.string(), thread_id: z.string().min(1) }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, role_key, thread_id }: any) => run(cwd, (store, project) => store.bindInitial(project, role_key, thread_id)));

tool("role_start", {
  title: "Start or recover role task", description: "Verify the active App Server task, return it idempotently when present, or deterministically replace a missing task without competing bootstrap turns.",
  inputSchema: { cwd, role_key: z.string(), model: z.string().optional() }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, role_key, model }: any) => runAsync(cwd, (store, project) => startRoleGeneration(store, project, role_key, { ...(model ? { model } : {}) })));

tool("role_context_get", {
  title: "Get layered role context", description: "Read the L0 constitution, L1 charter/state, active L2 tasks, generation, epoch, and pending mailbox count.",
  inputSchema: { cwd, role_key: z.string() }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd, role_key }: any) => run(cwd, (store, project) => store.context(project, role_key)));

tool("role_state_put", {
  title: "Put structured role state", description: "Store or supersede a provenance-labelled role fact instead of summarizing a transcript.",
  inputSchema: {
    cwd, role_key: z.string(), fact_key: z.string(), kind: z.enum(FACT_KINDS), content: z.string().min(1).max(20000),
    authority: z.enum(["user_decision", "project_authority", "agent_inference", "tool_observation"]), source: z.string().max(1000).optional()
  }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, role_key, ...input }: any) => run(cwd, (store, project) => store.putFact(project, role_key, input)));

tool("role_state_list", {
  title: "List structured role state", description: "List active charter, ownership, architecture, decision, invariant, failure, dependency, and artifact facts.",
  inputSchema: { cwd, role_key: z.string(), kind: z.enum(FACT_KINDS).optional() }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd, role_key, kind }: any) => run(cwd, (store, project) => store.listFacts(project, role_key, kind)));

tool("task_upsert", {
  title: "Upsert orchestration task", description: "Create or update a task packet with semantic owner, scope, acceptance criteria, architecture epoch, and dependencies.",
  inputSchema: {
    cwd, task_id: z.string().optional(), owner_role: z.string().optional(), title: z.string().min(1).max(300), goal: z.string().min(1).max(5000),
    status: z.enum(["pending", "active", "blocked", "verifying", "completed", "cancelled"]).default("pending"),
    scope: z.string().max(2000).default(""), acceptance_criteria: z.array(z.string()).max(100).default([]),
    payload: z.unknown().optional(), depends_on: z.array(z.string()).max(100).optional()
  }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, ...input }: any) => run(cwd, (store, project) => store.upsertTask(project, input)));

tool("task_graph", {
  title: "Read task graph", description: "Read project tasks, semantic owners, state, epoch, and dependency edges without loading module details into the Coordinator.",
  inputSchema: { cwd }, annotations: { readOnlyHint: true, idempotentHint: true }
}, ({ cwd }: any) => run(cwd, (store, project) => store.taskGraph(project)));

tool("message_send", {
  title: "Send typed role message", description: "Route an idempotent typed message to role:// identity. ASSIGN, VERIFY_REQUEST, and HANDOFF automatically create and wake non-Coordinator recipient tasks; result traffic never recursively wakes a running Coordinator.",
  inputSchema: {
    cwd, message_id: z.string().optional(), type: z.enum(MESSAGE_TYPES), from_role: z.string(), to_role: z.string(),
    from_generation: z.number().int().positive(), task_id: z.string().optional(), scope: z.string().max(2000).optional(),
    architecture_epoch: z.number().int().positive(), payload: z.unknown(), evidence_refs: z.array(z.string()).max(100).optional(), reply_to: z.string().optional()
  }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, ...input }: any) => runAsync(cwd, (store, project) => dispatchRoleMessage(store, project, input)));

tool("message_inbox", {
  title: "Read role mailbox", description: "Read typed messages addressed to a role and mark pending messages delivered.",
  inputSchema: { cwd, role_key: z.string(), include_acknowledged: z.boolean().default(false) }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, role_key, include_acknowledged }: any) => run(cwd, (store, project) => store.inbox(project, role_key, include_acknowledged)));

tool("message_ack", {
  title: "Acknowledge role message", description: "Acknowledge one typed message as its addressed role.",
  inputSchema: { cwd, role_key: z.string(), message_id: z.string() }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, role_key, message_id }: any) => run(cwd, (store, project) => store.acknowledgeMessage(project, role_key, message_id)));

tool("liaison_request", {
  title: "Send user request through Coordinator", description: "Start or recover the Coordinator task, send a user request from the active Liaison generation, wait for its response, and persist the response back to the Liaison mailbox. task_id, when supplied, is a Role Runtime task id rather than a Project Memory task id.",
  inputSchema: {
    cwd, liaison_generation: z.number().int().positive(), request: z.string().min(1).max(20000),
    task_id: z.string().optional(), scope: z.string().max(2000).optional(), message_id: z.string().optional()
  }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, ...input }: any) => runAsync(cwd, (store, project) => dispatchLiaisonRequest(store, project, input)));

tool("architecture_advance", {
  title: "Advance architecture epoch", description: "Invalidate work packets from the old architecture after an accepted material architecture change.",
  inputSchema: { cwd, reason: z.string().min(1).max(2000) }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, reason }: any) => run(cwd, (store, project) => store.advanceArchitecture(project, reason)));

tool("change_envelope_create", {
  title: "Create change envelope", description: "Define intent, allowed paths, symbols, constraints, non-goals, tests, semantic owner, and architecture epoch for a worker.",
  inputSchema: {
    cwd, task_id: z.string(), owner_role: z.string(), intent: z.string().min(1).max(5000), allowed_scope: z.array(z.string()).min(1).max(100),
    expected_symbols: z.array(z.string()).max(100).optional(), constraints: z.array(z.string()).max(100).optional(),
    non_goals: z.array(z.string()).max(100).optional(), tests: z.array(z.string()).max(100).optional()
  }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, ...input }: any) => run(cwd, (store, project) => store.createEnvelope(project, input)));

tool("change_envelope_check", {
  title: "Check actual change scope", description: "Compare actual changed paths with the envelope regex allowlist and reject stale architecture epochs.",
  inputSchema: { cwd, envelope_id: z.string(), actual_paths: z.array(z.string()).max(1000) }, annotations: { readOnlyHint: false, idempotentHint: true }
}, ({ cwd, envelope_id, actual_paths }: any) => run(cwd, (store, project) => store.checkEnvelope(project, envelope_id, actual_paths)));

tool("rotation_prepare", {
  title: "Prepare role generation rotation", description: "Freeze an authoritative checkpoint and start the crash-recoverable rotation state machine without retiring the active generation.",
  inputSchema: { cwd, role_key: z.string(), reason: z.string().min(1).max(2000) }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, role_key, reason }: any) => run(cwd, (store, project) => store.createRotation(project, role_key, reason)));

tool("rotation_candidate_register", {
  title: "Register candidate generation", description: "Register a new App Server thread as a bootstrapping candidate; it is not active yet.",
  inputSchema: { cwd, role_key: z.string(), thread_id: z.string(), bootstrap_hash: z.string().optional() }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, role_key, thread_id, bootstrap_hash }: any) => run(cwd, (store, project) => store.createCandidate(project, role_key, thread_id, bootstrap_hash)));

tool("rotation_cutover", {
  title: "Validate and cut over generation", description: "Compare candidate bootstrap facts with authoritative state, then atomically retire old generation and activate new generation.",
  inputSchema: {
    cwd, role_key: z.string(), candidate_id: z.string(), reason: z.string(),
    bootstrap: z.object({ role_id: z.string(), mission: z.string(), owned_domains: z.array(z.string()), critical_invariants: z.array(z.string()), open_questions: z.array(z.string()), architecture_epoch: z.number().int() })
  }, annotations: { readOnlyHint: false, idempotentHint: false }
}, ({ cwd, role_key, candidate_id, reason, bootstrap }: any) => run(cwd, (store, project) => {
  const validation = store.validateBootstrap(project, role_key, bootstrap);
  if (!validation.ok) { store.rejectCandidate(candidate_id, validation.errors.join("; ")); return { validation, cutover: false }; }
  return { validation, cutover: true, generation: store.activateCandidate(project, role_key, candidate_id, reason) };
}));

await server.connect(new StdioServerTransport());
