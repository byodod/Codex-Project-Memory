import { MemoryStore } from "./storage.js";
import { renderMemories, renderTask } from "./render.js";
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

function verificationLine(row: Record<string, unknown>): string {
  return `${row.status}: ${row.command || row.criterion || "verification"} — ${compactText(row.evidence, 300)}`;
}

async function run(input: HookInput): Promise<object | null> {
  const store = new MemoryStore();
  const project = resolveProject(input.cwd);
  try {
    const task = store.getActiveTask(project);
    switch (input.hook_event_name) {
      case "SessionStart": {
        store.recordEvent(project, {
          taskId: task?.id, sessionId: input.session_id, eventType: "session_start",
          payload: { source: input.source, model: input.model, branch: project.branch, revision: project.revision },
          authority: "tool_observation"
        });
        if (!task) return null;
        const verifications = store.listVerifications(project, task.id).slice(0, 5).map(verificationLine);
        const curated = store.search(project, "", {
          taskId: task.id, kinds: ["decision", "constraint", "project_fact", "tool_quirk"], limit: 6
        });
        const context = [renderTask(task, project, verifications), renderMemories(curated, "Active curated memory")].filter(Boolean).join("\n\n");
        return hookContext("SessionStart", context);
      }
      case "UserPromptSubmit": {
        const safePrompt = redact(input.prompt ?? "");
        store.recordEvent(project, {
          taskId: task?.id, sessionId: input.session_id, turnId: input.turn_id,
          eventType: "user_prompt", payload: safePrompt, authority: "user_decision"
        });
        const memories = store.search(project, compactText(safePrompt, 4000), { taskId: task?.id, limit: 6 });
        const context = renderMemories(memories);
        return context ? hookContext("UserPromptSubmit", context) : null;
      }
      case "PreToolUse": {
        const safeInput = redact(input.tool_input);
        const query = `${input.tool_name ?? ""} ${compactText(safeInput, 5000)}`;
        const memories = store.search(project, query, { taskId: task?.id, limit: 5 });
        const context = renderMemories(memories, "Memory relevant to the pending tool call");
        return context ? hookContext("PreToolUse", context) : null;
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
        if (error && exitCode !== 0) {
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
        store.checkpoint(project, {
          taskId: task?.id, sessionId: input.session_id, turnId: input.turn_id,
          trigger: `precompact:${input.trigger ?? "unknown"}`
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

try {
  const raw = await readStdin();
  const input = JSON.parse(raw) as HookInput;
  const output = await run(input);
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`Project Memory hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
