import { RoleStore, DefineRoleInput } from "./store.js";
import { ProjectContext } from "./types.js";

export const STANDARD_CONSTITUTION = "Preserve modular boundaries, route user communication through the Liaison, route project work through the Coordinator, route cross-domain decisions through semantic owners, and require independent verification.";

export const STANDARD_ROLES: readonly DefineRoleInput[] = [
  {
    role_key: "liaison",
    name: "User Liaison",
    kind: "governance",
    mission: "Serve as the user's conversational gateway: clarify intent, preserve user decisions, translate requests into structured messages for role://coordinator, and relay questions, progress, blockers, and verified results in user-facing language.",
    owned_domains: ["user communication", "intent clarification", "user decisions", "status synthesis"],
    excluded_domains: ["project scheduling", "architecture", "implementation", "verification"],
    escalation_rules: ["Route all internal work through role://coordinator", "Ask the user only when a decision materially changes scope, risk, cost, or outcome"],
    policy: { mode: "read_only", canDelegateTo: ["coordinator"] }
  },
  {
    role_key: "coordinator",
    name: "Coordinator",
    kind: "governance",
    mission: "Maintain project goal, task graph, dependencies, role directory, blockers, and routing without absorbing all module knowledge.",
    owned_domains: ["project goal", "task graph", "routing", "milestones"],
    excluded_domains: ["user-facing conversation", "implementation", "module internals"],
    escalation_rules: ["Exchange user requests, questions, and results only through role://liaison", "Architecture changes go to role://architect"],
    policy: { mode: "read_only", canDelegateTo: ["architect", "verifier"] }
  },
  {
    role_key: "architect",
    name: "Architect",
    kind: "governance",
    mission: "Protect system structure, semantic ownership, dependency direction, cross-module contracts, and migrations.",
    owned_domains: ["architecture", "module boundaries", "dependency direction", "cross-module contracts"],
    excluded_domains: ["user-facing conversation", "routine implementation"],
    escalation_rules: ["Product-direction decisions return to role://coordinator and role://liaison"],
    policy: { mode: "read_only", canDelegateTo: ["verifier"] }
  },
  {
    role_key: "verifier",
    name: "Verifier",
    kind: "governance",
    mission: "Independently verify requirements, architecture consistency, actual diff scope, and objective test evidence.",
    owned_domains: ["verification", "acceptance", "diff review"],
    excluded_domains: ["user-facing conversation", "implementation"],
    escalation_rules: ["Reject unverifiable or out-of-scope changes and report through role://coordinator"],
    policy: { mode: "read_only", freshVerification: true }
  }
];

export function isRoleInitializationPrompt(prompt: string | undefined): boolean {
  if (!prompt) return false;
  const normalized = prompt.trim().replace(/[。.!！]+$/u, "").trim().toLowerCase();
  return normalized === "初始化角色编排" || normalized === "启动角色编排" || normalized === "initialize role orchestration";
}

export function initializeStandardTopology(store: RoleStore, project: ProjectContext, constitution?: string): Record<string, unknown> {
  const existing = store.ensureProject(project);
  if (constitution !== undefined || !String(existing.constitution || "").trim()) {
    store.configureProject(project, constitution ?? STANDARD_CONSTITUTION);
  }
  const roles = STANDARD_ROLES.map((role) => store.defineRole(project, role));
  return {
    project: store.configureProject(project),
    entry_role: "liaison",
    coordinator_role: "coordinator",
    roles
  };
}
