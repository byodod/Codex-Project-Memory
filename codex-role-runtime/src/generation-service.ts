import { AppServerClient } from "./app-server.js";
import { RoleStore, SendMessageInput } from "./store.js";
import { BootstrapResponse, GenerationRecord, ProjectContext, RolePolicy, RoleRecord } from "./types.js";

export interface GenerationClient {
  startThread(input: { cwd: string; model?: string; policy: RolePolicy; name: string }): Promise<string>;
  close(): void;
}

export interface DispatchClient {
  runTurn(threadId: string, prompt: string, timeoutMs?: number): Promise<string>;
  close(): void;
}

export interface GenerationOptions {
  model?: string;
  clientFactory?: () => Promise<GenerationClient>;
}

export interface DispatchOptions {
  generationOptions?: GenerationOptions;
  clientFactory?: () => Promise<DispatchClient>;
  timeoutMs?: number;
}

export function expectedBootstrap(store: RoleStore, project: ProjectContext, role: RoleRecord): BootstrapResponse {
  const context = store.context(project, role.role_key);
  const facts = context.facts as Array<Record<string, unknown>>;
  return {
    role_id: role.role_key,
    mission: role.mission,
    owned_domains: role.owned_domains,
    critical_invariants: facts.filter((fact) => fact.kind === "invariant").map((fact) => String(fact.content)),
    open_questions: facts.filter((fact) => fact.kind === "open_question").map((fact) => String(fact.content)),
    architecture_epoch: Number((context.project as Record<string, unknown>).architecture_epoch)
  };
}

export async function rotateRoleGeneration(store: RoleStore, project: ProjectContext, roleKey: string, reason: string, options: GenerationOptions = {}): Promise<unknown> {
  const role = store.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
  const rotation = store.createRotation(project, roleKey, reason);
  let client: GenerationClient | null = null;
  let candidate: GenerationRecord | null = null;
  try {
    client = options.clientFactory ? await options.clientFactory() : await AppServerClient.connect();
    store.updateRotation(String(rotation.id), "DRAINING");
    store.updateRotation(String(rotation.id), "CHECKPOINTING");
    store.updateRotation(String(rotation.id), "VALIDATING");
    const threadId = await client.startThread({ cwd: project.root, ...(options.model ? { model: options.model } : {}), policy: role.policy, name: `${role.name} · Generation` });
    const expected = expectedBootstrap(store, project, role);
    candidate = store.createCandidate(project, roleKey, threadId, JSON.stringify(expected));
    store.updateRotation(String(rotation.id), "BOOTSTRAPPING", { candidateId: candidate.id });
    const validation = store.validateBootstrap(project, roleKey, expected);
    if (!validation.ok) {
      store.rejectCandidate(candidate.id, validation.errors.join("; "));
      store.updateRotation(String(rotation.id), "FAILED", { error: validation.errors.join("; ") });
      throw new Error(`Bootstrap rejected: ${validation.errors.join("; ")}`);
    }
    store.updateRotation(String(rotation.id), "CUTOVER");
    const active = store.activateCandidate(project, roleKey, candidate.id, reason);
    store.updateRotation(String(rotation.id), "COMPLETED");
    return { rotation_id: rotation.id, role: roleKey, generation: active, validation };
  } catch (error) {
    if (candidate) {
      try { store.rejectCandidate(candidate.id, `Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* retain original error */ }
    }
    try { store.updateRotation(String(rotation.id), "FAILED", { error: error instanceof Error ? error.message : String(error) }); } catch { /* retain original error */ }
    throw error;
  } finally { client?.close(); }
}

export function handoffRoleGenerationToThread(store: RoleStore, project: ProjectContext, roleKey: string, threadId: string, reason: string): unknown {
  const role = store.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
  const active = store.activeGeneration(project, roleKey);
  if (active?.thread_id === threadId) return { role: roleKey, status: "active", handed_off: false, generation: active };
  if (store.getGenerationByThread(project, threadId)) throw new Error("THREAD_ALREADY_BOUND");
  if (store.bootstrappingGeneration(project, roleKey) || store.openRotation(project, roleKey)) throw new Error("ROLE_ROTATION_ALREADY_IN_PROGRESS");

  const rotation = store.createRotation(project, roleKey, reason);
  let candidate: GenerationRecord | null = null;
  try {
    store.updateRotation(String(rotation.id), "DRAINING");
    store.updateRotation(String(rotation.id), "CHECKPOINTING");
    store.updateRotation(String(rotation.id), "VALIDATING");
    const expected = expectedBootstrap(store, project, role);
    candidate = store.createCandidate(project, roleKey, threadId, JSON.stringify(expected));
    store.updateRotation(String(rotation.id), "BOOTSTRAPPING", { candidateId: candidate.id });
    const validation = store.validateBootstrap(project, roleKey, expected);
    if (!validation.ok) throw new Error(`Bootstrap rejected: ${validation.errors.join("; ")}`);
    store.updateRotation(String(rotation.id), "CUTOVER");
    const next = store.activateCandidate(project, roleKey, candidate.id, reason);
    store.updateRotation(String(rotation.id), "COMPLETED");
    return { rotation_id: rotation.id, role: roleKey, status: "active", handed_off: Boolean(active), generation: next, validation };
  } catch (error) {
    if (candidate) {
      try { store.rejectCandidate(candidate.id, `Existing-thread handoff failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* retain original error */ }
    }
    try { store.updateRotation(String(rotation.id), "FAILED", { error: error instanceof Error ? error.message : String(error) }); } catch { /* retain original error */ }
    throw error;
  }
}

export async function startRoleGeneration(store: RoleStore, project: ProjectContext, roleKey: string, options: GenerationOptions = {}): Promise<unknown> {
  const active = store.activeGeneration(project, roleKey);
  if (active) return { role: roleKey, status: "active", started: false, generation: active };
  const candidate = store.bootstrappingGeneration(project, roleKey);
  const rotation = store.openRotation(project, roleKey);
  if (candidate && rotation) return { role: roleKey, status: "bootstrapping", started: false, generation: candidate, rotation_id: rotation.id };
  if (candidate) store.rejectCandidate(candidate.id, "Recovered orphaned bootstrap candidate before retrying role_start.");
  if (rotation) return { role: roleKey, status: "starting", started: false, rotation_id: rotation.id };
  const result = await rotateRoleGeneration(store, project, roleKey, "initial generation", options) as Record<string, unknown>;
  return { ...result, status: "active", started: true };
}

const AUTO_WAKE_TYPES = new Set(["ASSIGN", "VERIFY_REQUEST", "HANDOFF"]);

export async function dispatchRoleMessage(store: RoleStore, project: ProjectContext, input: SendMessageInput, options: DispatchOptions = {}): Promise<unknown> {
  const message = store.sendMessage(project, input);
  const shouldWake = AUTO_WAKE_TYPES.has(input.type) && input.to_role !== "coordinator" && input.to_role !== "liaison";
  if (!shouldWake) return { message, wake: { status: "not_required" } };

  let generation = store.activeGeneration(project, input.to_role);
  let startup: unknown = null;
  if (!generation) {
    startup = await startRoleGeneration(store, project, input.to_role, options.generationOptions);
    generation = store.activeGeneration(project, input.to_role);
  }
  if (!generation) throw new Error(`ROLE_WAKE_TARGET_NOT_ACTIVE: role://${input.to_role}`);

  if (!store.claimMessageWake(project, String(message.id))) {
    const current = store.message(project, String(message.id));
    return { message: current ?? message, startup, wake: { status: String(current?.wake_status || "already_claimed"), deduplicated: true } };
  }

  const client = options.clientFactory ? await options.clientFactory() : await AppServerClient.connect();
  try {
    const response = await client.runTurn(generation.thread_id, [
      store.roleAnchor(project, input.to_role),
      `A durable ${input.type} message has arrived from role://${input.from_role}. Process it now; this is an active work turn, not an anchor-only bootstrap.`,
      "Read the authoritative typed inbox and task graph before acting. Acknowledge the message after consuming it.",
      `Return RESULT, BLOCKED, or QUESTION through the typed role channel to role://${input.from_role}. Do not address the user directly.`,
      `Dispatched message: ${JSON.stringify({ id: message.id, type: input.type, task_id: message.task_id, scope: message.scope, payload: input.payload })}`
    ].join("\n\n"), options.timeoutMs);
    const completed = store.finishMessageWake(project, String(message.id));
    return { message: completed, startup, wake: { status: "completed", role: input.to_role, generation: generation.generation_number, response } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    store.failMessageWake(project, String(message.id), reason);
    throw new Error(`ROLE_WAKE_FAILED: role://${input.to_role}: ${reason}`);
  } finally { client.close(); }
}

export async function dispatchLiaisonRequest(store: RoleStore, project: ProjectContext, input: { liaison_generation: number; request: string; task_id?: string; scope?: string; message_id?: string }): Promise<unknown> {
  const liaison = store.getRole(project, "liaison");
  const coordinator = store.getRole(project, "coordinator");
  if (!liaison || !coordinator) throw new Error("STANDARD_TOPOLOGY_NOT_INITIALIZED");
  store.assertCurrent(liaison, input.liaison_generation);
  const coordinatorGeneration = store.activeGeneration(project, "coordinator");
  if (!coordinatorGeneration) throw new Error("COORDINATOR_NOT_ACTIVE: call role_start for role://coordinator first");
  const architectureEpoch = store.projectEpoch(project);
  const requestInput: SendMessageInput = {
    ...(input.message_id ? { message_id: input.message_id } : {}),
    type: "ASSIGN",
    from_role: "liaison",
    to_role: "coordinator",
    from_generation: input.liaison_generation,
    ...(input.task_id ? { task_id: input.task_id } : {}),
    scope: input.scope || "",
    architecture_epoch: architectureEpoch,
    payload: { user_request: input.request }
  };
  const requestMessage = store.sendMessage(project, requestInput);
  store.inbox(project, "coordinator");
  const client = await AppServerClient.connect();
  try {
    const responseText = await client.runTurn(coordinatorGeneration.thread_id, [
      store.roleAnchor(project, "coordinator"),
      "A request arrived from role://liaison. Coordinate the internal work needed to answer it. Use durable tasks and typed role messages when useful.",
      "Return a concise response for role://liaison containing questions, progress, blockers, decisions needed, or verified results. Do not address the user directly.",
      `Request message: ${JSON.stringify({ id: requestMessage.id, task_id: requestMessage.task_id, scope: requestMessage.scope, payload: { user_request: input.request } })}`
    ].join("\n\n"));
    const resultMessage = store.sendMessage(project, {
      type: "RESULT",
      from_role: "coordinator",
      to_role: "liaison",
      from_generation: coordinatorGeneration.generation_number,
      ...(input.task_id ? { task_id: input.task_id } : {}),
      scope: input.scope || "",
      architecture_epoch: store.projectEpoch(project),
      payload: { response: responseText },
      reply_to: String(requestMessage.id)
    });
    store.acknowledgeMessage(project, "coordinator", String(requestMessage.id));
    return { request_message: requestMessage, result_message: resultMessage, response: responseText };
  } finally { client.close(); }
}
