import { RoleStore, SendMessageInput } from "./store.js";
import { BootstrapResponse, GenerationRecord, ProjectContext, RoleRecord } from "./types.js";

export interface LiaisonRequestInput {
  liaison_generation: number;
  request: string;
  task_id?: string;
  scope?: string;
  message_id?: string;
}

export interface LiaisonResultInput {
  request_message_id: string;
  response: string;
  message_id?: string;
  evidence_refs?: string[];
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

function completeAttachment(store: RoleStore, project: ProjectContext, roleKey: string, threadId: string, reason: string, rotation: Record<string, unknown>, candidate: GenerationRecord): unknown {
  const role = store.getRole(project, roleKey)!;
  store.updateRotation(String(rotation.id), "BOOTSTRAPPING", { candidateId: candidate.id });
  const validation = store.validateBootstrap(project, roleKey, expectedBootstrap(store, project, role));
  if (!validation.ok) {
    store.rejectCandidate(candidate.id, validation.errors.join("; "));
    store.updateRotation(String(rotation.id), "FAILED", { error: validation.errors.join("; ") });
    throw new Error(`Bootstrap rejected: ${validation.errors.join("; ")}`);
  }
  store.updateRotation(String(rotation.id), "CUTOVER");
  const generation = store.activateCandidate(project, roleKey, candidate.id, reason);
  store.updateRotation(String(rotation.id), "COMPLETED");
  return { role: roleKey, status: "active", attached: true, thread_id: threadId, rotation_id: rotation.id, generation, validation };
}

/** Attach a task that the Codex desktop LLM has already found or created. */
export function attachRoleThread(store: RoleStore, project: ProjectContext, roleKey: string, threadId: string, reason = "Attached by Codex desktop task orchestration."): unknown {
  const role = store.getRole(project, roleKey);
  if (!role) throw new Error(`Unknown role: ${roleKey}`);
  const active = store.activeGeneration(project, roleKey);
  if (active?.thread_id === threadId) return { role: roleKey, status: "active", attached: false, thread_id: threadId, generation: active };

  const bound = store.getGenerationByThread(project, threadId);
  if (bound && bound.role.role_key !== roleKey) throw new Error("THREAD_ALREADY_BOUND_TO_ANOTHER_ROLE");
  const openCandidate = store.bootstrappingGeneration(project, roleKey);
  const openRotation = store.openRotation(project, roleKey) as Record<string, unknown> | null;
  if (bound?.generation.status === "bootstrapping" && openCandidate?.id === bound.generation.id && openRotation) {
    return completeAttachment(store, project, roleKey, threadId, reason, openRotation, openCandidate);
  }
  if (bound) throw new Error("THREAD_ALREADY_BOUND_TO_RETIRED_GENERATION");

  // A desktop-observed task id is authoritative. Clear interrupted local
  // bookkeeping so a direct rebind cannot be blocked by stale state.
  if (openCandidate) store.rejectCandidate(openCandidate.id, `Superseded by desktop task ${threadId}.`);
  if (openRotation) store.updateRotation(String(openRotation.id), "FAILED", { error: `Superseded by desktop task ${threadId}.` });

  const rotation = store.createRotation(project, roleKey, reason) as Record<string, unknown>;
  let candidate: GenerationRecord | null = null;
  try {
    store.updateRotation(String(rotation.id), "DRAINING");
    store.updateRotation(String(rotation.id), "CHECKPOINTING");
    store.updateRotation(String(rotation.id), "VALIDATING");
    candidate = store.createCandidate(project, roleKey, threadId, JSON.stringify(expectedBootstrap(store, project, role)));
    return completeAttachment(store, project, roleKey, threadId, reason, rotation, candidate);
  } catch (error) {
    if (candidate) {
      try { store.rejectCandidate(candidate.id, `Task attachment failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* retain original error */ }
    }
    try { store.updateRotation(String(rotation.id), "FAILED", { error: error instanceof Error ? error.message : String(error) }); } catch { /* retain original error */ }
    throw error;
  }
}

function recipientRoute(store: RoleStore, project: ProjectContext, roleKey: string): Record<string, unknown> {
  const generation = store.activeGeneration(project, roleKey);
  return generation
    ? { role: roleKey, status: "active", thread_id: generation.thread_id, generation: generation.generation_number }
    : { role: roleKey, status: "needs_task", thread_id: null, generation: null };
}

/** Persist a typed message and return the desktop task route. No hidden wake occurs. */
export function routeRoleMessage(store: RoleStore, project: ProjectContext, input: SendMessageInput): unknown {
  const message = store.sendMessage(project, input);
  return { message, recipient: recipientRoute(store, project, input.to_role), dispatch: "desktop_task_tools" };
}

/** Persist Liaison intent and return the Coordinator task/prompt for desktop dispatch. */
export function prepareLiaisonRequest(store: RoleStore, project: ProjectContext, input: LiaisonRequestInput): unknown {
  const liaison = store.getRole(project, "liaison");
  const coordinator = store.getRole(project, "coordinator");
  if (!liaison || !coordinator) throw new Error("STANDARD_TOPOLOGY_NOT_INITIALIZED");
  store.assertCurrent(liaison, input.liaison_generation);
  const requestMessage = store.sendMessage(project, {
    ...(input.message_id ? { message_id: input.message_id } : {}),
    type: "ASSIGN",
    from_role: "liaison",
    to_role: "coordinator",
    from_generation: input.liaison_generation,
    ...(input.task_id ? { task_id: input.task_id } : {}),
    scope: input.scope || "",
    architecture_epoch: store.projectEpoch(project),
    payload: { user_request: input.request }
  });
  const recipient = recipientRoute(store, project, "coordinator");
  const prompt = [
    store.roleAnchor(project, "coordinator"),
    "A durable request arrived from role://liaison. Coordinate the internal work needed to answer it.",
    "Read the authoritative typed inbox and task graph before acting. Return a concise response for role://liaison; do not address the user directly.",
    `Request message: ${JSON.stringify({ id: requestMessage.id, task_id: requestMessage.task_id, scope: requestMessage.scope, payload: { user_request: input.request } })}`
  ].join("\n\n");
  return { request_message: requestMessage, recipient, prompt, dispatch: "desktop_task_tools" };
}

/** Persist the response obtained through desktop wait/read and acknowledge its request. */
export function recordLiaisonResult(store: RoleStore, project: ProjectContext, input: LiaisonResultInput): unknown {
  const request = store.message(project, input.request_message_id);
  if (!request || request.type !== "ASSIGN" || request.from_role !== "liaison" || request.to_role !== "coordinator") {
    throw new Error("LIAISON_REQUEST_NOT_FOUND");
  }
  const coordinatorGeneration = store.activeGeneration(project, "coordinator");
  if (!coordinatorGeneration) throw new Error("COORDINATOR_NOT_ATTACHED");
  const resultMessage = store.sendMessage(project, {
    message_id: input.message_id || `result:${input.request_message_id}`,
    type: "RESULT",
    from_role: "coordinator",
    to_role: "liaison",
    from_generation: coordinatorGeneration.generation_number,
    ...(request.task_id ? { task_id: String(request.task_id) } : {}),
    scope: String(request.scope || ""),
    architecture_epoch: store.projectEpoch(project),
    payload: { response: input.response },
    ...(input.evidence_refs ? { evidence_refs: input.evidence_refs } : {}),
    reply_to: input.request_message_id
  });
  store.acknowledgeMessage(project, "coordinator", input.request_message_id);
  return { request_message: store.message(project, input.request_message_id), result_message: resultMessage, response: input.response };
}

export const handoffRoleGenerationToThread = attachRoleThread;
