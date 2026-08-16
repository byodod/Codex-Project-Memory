// src/integrated-hook.ts
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var root = dirname(fileURLToPath(import.meta.url));
var raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
var input = JSON.parse(raw);
function invoke(file, env) {
  const run = spawnSync(process.execPath, ["--no-warnings", join(root, file)], { input: raw, encoding: "utf8", env });
  if (run.status !== 0) throw new Error(`${file} failed: ${run.stderr.trim() || `exit ${run.status}`}`);
  return run.stdout.trim() ? JSON.parse(run.stdout) : {};
}
function merge(memory, role) {
  const blocking = [memory, role].find((value) => value.decision === "block" || value.continue === false);
  if (blocking) return blocking;
  const memoryHook = memory.hookSpecificOutput || {};
  const roleHook = role.hookSpecificOutput || {};
  const additionalContext = [memoryHook.additionalContext, roleHook.additionalContext].filter(Boolean).join("\n\n");
  const hookSpecificOutput = { ...memoryHook, ...roleHook };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  if (!hookSpecificOutput.hookEventName && input.hook_event_name) hookSpecificOutput.hookEventName = input.hook_event_name;
  return Object.keys(hookSpecificOutput).length > 1 || additionalContext ? { ...memory, ...role, hookSpecificOutput } : { ...memory, ...role };
}
try {
  const memory = invoke("hook.mjs", process.env);
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const roleHome = process.env.CODEX_ROLE_RUNTIME_HOME || join(codexHome, "plugin-data", "codex-role-runtime");
  const role = invoke("role-hook.mjs", { ...process.env, CODEX_ROLE_RUNTIME_HOME: roleHome });
  const output = merge(memory, role);
  if (Object.keys(output).length) process.stdout.write(`${JSON.stringify(output)}
`);
} catch (error) {
  process.stderr.write(`Integrated project runtime hook failed: ${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
}
