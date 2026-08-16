import { readFileSync } from "node:fs";
import { handoffRoleGenerationToThread } from "./generation-service.js";
import { resolveProject } from "./project.js";
import { RoleStore } from "./store.js";
import { initializeStandardTopology, isRoleInitializationPrompt } from "./topology.js";
import { HookInput } from "./types.js";
import { matchesAny, redact } from "./util.js";

function readInput(): HookInput {
  const raw = readFileSync(0, "utf8");
  const value = JSON.parse(raw) as HookInput;
  if (!value.session_id || !value.cwd || !value.hook_event_name) throw new Error("Invalid Codex hook input.");
  return value;
}

function context(event: string, text: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function deny(event: string, reason: string): Record<string, unknown> {
  if (event === "UserPromptSubmit") return { decision: "block", reason };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

const desktopTaskContract = `Use exact desktop shapes: list_projects({}); list_threads({ limit }); create_thread({ target: { type: "project", projectId, environment: { type: "local" } }, prompt, title }); read_thread({ threadId, hostId, includeOutputs, turnLimit, maxOutputCharsPerItem }); send_message_to_thread({ threadId, hostId, prompt }); wait_threads({ targets: [{ threadId, hostId }], timeoutMs }). Match the current project root. projectId belongs only at create_thread.target.projectId; never add a top-level projectId beside target. The send field is prompt, never message/content/taskId/projectId/target. If create_thread returns only clientThreadId, do not attach/read/send/wait it, create another task, or fall back to fork_thread. Resolve that same task's real threadId and hostId through list_threads, then call role_attach.`;

function isMutatingShell(value: unknown): boolean {
  const command = typeof value === "object" && value ? String((value as Record<string, unknown>).command || "") : "";
  return /(^|[;&|]\s*)(rm|del|erase|rmdir|remove-item|move-item|copy-item|mv|cp|mkdir|md|touch|new-item|set-content|add-content)\b|(^|\s)(git\s+(commit|merge|rebase|cherry-pick|reset|checkout|switch|add)|npm\s+(install|update)|pnpm\s+(install|add)|yarn\s+add)\b|(^|[^>])>{1,2}(?!>)/i.test(command);
}

const input = readInput();
const store = new RoleStore();
try {
  const project = resolveProject(input.cwd);
  let binding = store.getGenerationByThread(project, input.session_id);

  if (!binding && input.hook_event_name === "UserPromptSubmit") {
    if (isRoleInitializationPrompt(input.prompt)) {
      initializeStandardTopology(store, project);
      const active = store.activeGeneration(project, "liaison");
      const liaison = active
        ? handoffRoleGenerationToThread(store, project, "liaison", input.session_id, "User selected a new Liaison entry task with the exact initialization prompt.")
        : { handed_off: false, generation: store.bindInitial(project, "liaison", input.session_id) };
      const action = active ? "resumed and handed off" : "initialized";
      process.stdout.write(JSON.stringify(context(input.hook_event_name, `Role orchestration ${action}. This task is now the user's communication entry point.\n${store.roleAnchor(project, "liaison")}\nUse Codex desktop task tools directly to list or read the Coordinator task. If it is missing, archived, deleted, or otherwise unavailable, create one replacement and attach its real task id. ${desktopTaskContract} Do not use Codex CLI or App Server for task lifecycle operations. Then route structured user intent to role://coordinator and relay its questions, progress, blockers, and verified results back to the user.`)));
      process.exit(0);
    }
    const claim = input.prompt?.match(/^\s*role:\/\/bind\s+([a-z0-9-]+)\s*$/i);
    if (claim?.[1]) {
      const generation = store.bindInitial(project, claim[1], input.session_id);
      binding = store.getGenerationByThread(project, input.session_id);
      process.stdout.write(JSON.stringify(context(input.hook_event_name, `Role binding created at generation ${generation.generation_number}.\n${store.roleAnchor(project, claim[1])}`)));
      process.exit(0);
    }
  }

  if (!binding) {
    store.recordEvent(project, { event_type: `unbound:${input.hook_event_name}`, event_key: `${input.session_id}:${input.turn_id || input.source || input.hook_event_name}:${input.hook_event_name}`, payload: redact(input) });
    process.stdout.write("{}");
    process.exit(0);
  }

  const { role, generation } = binding;
  const bootstrapping = generation.status === "bootstrapping";
  const stale = generation.status === "retired" || generation.status === "rejected";
  const eventKey = `${input.session_id}:${input.turn_id || input.tool_use_id || input.trigger || input.source || input.hook_event_name}:${input.hook_event_name}`;

  switch (input.hook_event_name) {
    case "SessionStart":
      if (stale) process.stdout.write(JSON.stringify({ continue: false, stopReason: `STALE_GENERATION: role://${role.role_key} now uses another thread.` }));
      else if (bootstrapping) process.stdout.write(JSON.stringify(context("SessionStart", `This task is a bootstrap candidate and is not active yet. Do not perform project work until deterministic cutover completes.\n${store.roleAnchor(project, role.role_key, generation)}`)));
      else {
        store.observeGeneration(project, input.session_id, { event: "session_start", eventKey });
        process.stdout.write(JSON.stringify(context("SessionStart", store.roleAnchor(project, role.role_key))));
      }
      break;
    case "UserPromptSubmit":
      if (stale) process.stdout.write(JSON.stringify(deny("UserPromptSubmit", `STALE_GENERATION: this thread is retired for role://${role.role_key}. Open its current generation.`)));
      else if (bootstrapping) process.stdout.write(JSON.stringify(deny("UserPromptSubmit", `BOOTSTRAPPING_GENERATION: role://${role.role_key} candidate ${generation.generation_number} is awaiting deterministic cutover.`)));
      else {
        store.observeGeneration(project, input.session_id, { event: "turn", eventKey });
        process.stdout.write(JSON.stringify(context("UserPromptSubmit", store.roleAnchor(project, role.role_key))));
      }
      break;
    case "PreToolUse": {
      if (stale) { process.stdout.write(JSON.stringify(deny("PreToolUse", `STALE_GENERATION: retired generation ${generation.generation_number} cannot use tools.`))); break; }
      if (bootstrapping) { process.stdout.write(JSON.stringify(deny("PreToolUse", `BOOTSTRAPPING_GENERATION: candidate ${generation.generation_number} cannot use tools before deterministic cutover.`))); break; }
      const tool = input.tool_name || "";
      if (matchesAny(tool, role.policy.deniedTools) || (role.policy.mode === "read_only" && tool === "Bash" && isMutatingShell(input.tool_input))) {
        process.stdout.write(JSON.stringify(deny("PreToolUse", `Role policy denies ${tool} for role://${role.role_key} (${role.policy.mode}). Delegate implementation to a writable worker.`)));
      } else process.stdout.write(JSON.stringify(context("PreToolUse", `Role policy active for role://${role.role_key}; architecture epoch ${generation.architecture_epoch}.`)));
      break;
    }
    case "PostCompact":
      store.observeGeneration(project, input.session_id, { event: "compact", eventKey });
      process.stdout.write("{}");
      break;
    case "PreCompact":
      store.recordEvent(project, { event_type: "pre_compact", event_key: eventKey, role_id: role.id, generation_id: generation.id, payload: { trigger: input.trigger } });
      process.stdout.write("{}");
      break;
    default:
      store.recordEvent(project, { event_type: input.hook_event_name, event_key: eventKey, role_id: role.id, generation_id: generation.id, payload: redact(input) });
      store.observeGeneration(project, input.session_id, { event: "seen", eventKey: `${eventKey}:seen` });
      process.stdout.write("{}");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally { store.close(); }
