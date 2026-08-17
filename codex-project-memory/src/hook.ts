import { MemoryStore, readLastGoodCapsuleFile, resolveMemoryDataRoot } from "./storage.js";
import { renderMainlineCapsule, renderMemories } from "./render.js";
import { resolveProject } from "./repository.js";
import { HookInput } from "./types.js";
import { compactText, redact } from "./util.js";

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function hookContext(event: string, additionalContext: string): object {
  return { hookSpecificOutput: { hookEventName: event, additionalContext } };
}

function fallbackSessionStart(input: HookInput): object | null {
  if (input.hook_event_name !== "SessionStart") return null;
  const project = resolveProject(input.cwd);
  const capsule = readLastGoodCapsuleFile(resolveMemoryDataRoot(), project);
  if (!capsule) return null;
  const budget = input.source === "compact" ? 6000 : 6500;
  return hookContext("SessionStart", renderMainlineCapsule(capsule, budget));
}

function extractExitCode(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode", "code"]) {
    if (typeof object[key] === "number") return object[key] as number;
  }
  const text = compactText(value, 4000);
  const match = text.match(/(?:exit[_ ]code|Process exited with code)\D*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function extractFile(value: unknown): string | null {
  const text = compactText(value, 5000);
  const match = text.match(/(?:[A-Za-z]:\\|\/)?(?:[\w .-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|cs|go|rs|java|kt|swift|cpp|c|h|json|toml|ya?ml|md)/i);
  return match?.[0] ?? null;
}

function extractError(value: unknown): string | null {
  const text = compactText(value, 8000);
  const lines = text.split("\n").filter((line) => /\b(error|exception|failed|failure|fatal|CS\d{4}|TS\d{4})\b/i.test(line));
  return lines.length ? compactText(lines.slice(0, 3).join(" | "), 1000) : null;
}

async function run(input: HookInput): Promise<object | null> {
  const store = new MemoryStore();
  const project = resolveProject(input.cwd);
  try {
    const task = store.getActiveTask(project);
    const plan = store.getActivePlan(project);
    switch (input.hook_event_name) {
      case "SessionStart": {
        store.recordEvent(project, {
          taskId: task?.id, sessionId: input.session_id, eventType: "session_start",
          payload: { source: input.source, model: input.model, branch: project.branch, revision: project.revision },
          authority: "tool_observation"
        });
        if (!task && !plan) return null;
        const budget = input.source === "compact" ? 6000 : 6500;
        let capsule;
        try {
          capsule = store.mainlineCapsule(project);
        } catch (error) {
          capsule = store.readLastGoodCapsule(project);
          if (!capsule) throw error;
        }
        const curated = store.search(project, "", {
          taskId: task?.id, kinds: ["decision", "constraint", "project_fact", "tool_quirk"], limit: 4
        });
        const mainline = renderMainlineCapsule(capsule, budget);
        const remaining = Math.max(0, budget - mainline.length - 2);
        const context = [mainline, remaining >= 400 ? renderMemories(curated, "Active curated memory", remaining) : ""]
          .filter(Boolean).join("\n\n").slice(0, budget);
        return hookContext("SessionStart", context);
      }
      case "UserPromptSubmit": {
        const safePrompt = redact(input.prompt ?? "");
        store.recordEvent(project, {
          taskId: task?.id, sessionId: input.session_id, turnId: input.turn_id,
          eventType: "user_prompt", payload: safePrompt, authority: "user_decision"
        });
        const memories = store.search(project, compactText(safePrompt, 4000), { taskId: task?.id, limit: 6 });
        const context = renderMemories(memories, "Relevant project memory", 4000);
        return context ? hookContext("UserPromptSubmit", context) : null;
      }
      case "PostToolUse": {
        const safeInput = redact(input.tool_input);
        const safeResponse = redact(input.tool_response);
        const exitCode = extractExitCode(input.tool_response);
        const error = extractError(input.tool_response);
        store.recordEvent(project, {
          taskId: task?.id, sessionId: input.session_id, turnId: input.turn_id, toolUseId: input.tool_use_id,
          eventType: "tool_result", payload: { tool_name: input.tool_name, input: safeInput, response: safeResponse },
          exitCode, filePath: extractFile(input.tool_input), errorSignature: error, authority: "tool_observation"
        });
        if (error && exitCode !== null && exitCode !== 0) {
          store.storeMemory(project, {
            task_id: task?.id, kind: "episodic", summary: `Observed failure in ${input.tool_name ?? "tool"}`,
            content: error, authority: "tool_observation", confidence: 0.95, importance: 0.35,
            source_note: input.tool_use_id ? `tool_use_id=${input.tool_use_id}` : "PostToolUse",
            file_path: extractFile(input.tool_input) ?? undefined, error_signature: error,
            tags: ["auto-captured", "failure"]
          });
        }
        return null;
      }
      case "PreCompact": {
        try {
          store.checkpoint(project, {
            taskId: task?.id, sessionId: input.session_id, turnId: input.turn_id,
            trigger: `precompact:${input.trigger ?? "unknown"}`
          });
        } catch (error) {
          process.stderr.write(`Project Memory checkpoint degraded: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        return null;
      }
      case "PostCompact": {
        store.recordEvent(project, {
          taskId: task?.id, sessionId: input.session_id, turnId: input.turn_id,
          eventType: "post_compact", payload: { trigger: input.trigger ?? "unknown" }, authority: "tool_observation"
        });
        return null;
      }
      case "Stop": {
        if (input.last_assistant_message) {
          store.recordEvent(project, {
            taskId: task?.id, sessionId: input.session_id, turnId: input.turn_id,
            eventType: "assistant_stop", payload: redact(input.last_assistant_message), authority: "agent_inference"
          });
        }
        if (!task || !task.gate_enabled || input.stop_hook_active) return {};
        const issues = store.completionIssues(task);
        if (!issues.length) return {};
        return {
          decision: "block",
          reason: `Project Memory completion gate: ${issues.join(" ")} Update the task snapshot and complete the remaining work, or explicitly pause the task if work should stop.`
        };
      }
      case "SessionEnd": {
        if (input.last_assistant_message) {
          store.recordEvent(project, {
            taskId: task?.id, sessionId: input.session_id, eventType: "session_end_summary",
            payload: redact(input.last_assistant_message), authority: "agent_inference"
          });
        }
        store.exportProject(project);
        return null;
      }
      default:
        return null;
    }
  } finally {
    store.close();
  }
}

let parsedInput: HookInput | null = null;
try {
  const raw = await readStdin();
  parsedInput = JSON.parse(raw) as HookInput;
  const output = await run(parsedInput);
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const fallback = parsedInput ? fallbackSessionStart(parsedInput) : null;
  if (fallback) {
    process.stderr.write(`Project Memory hook degraded: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
  } else if (parsedInput?.hook_event_name === "PreCompact") {
    process.stderr.write(`Project Memory checkpoint degraded: ${error instanceof Error ? error.message : String(error)}\n`);
  } else {
    process.stderr.write(`Project Memory hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
