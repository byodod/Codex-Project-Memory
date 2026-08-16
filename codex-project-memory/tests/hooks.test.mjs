import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryStore, resolveProject } from "../dist/library.mjs";

const hookPath = resolve("dist/hook.mjs");
const integratedHookPath = resolve("dist/integrated-hook.mjs");

function invoke(input, dataHome, cwd) {
  const run = spawnSync(process.execPath, ["--no-warnings", hookPath], {
    cwd,
    env: { ...process.env, CODEX_PROJECT_MEMORY_HOME: dataHome },
    input: JSON.stringify(input), encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim() ? JSON.parse(run.stdout) : null;
}

test("hooks rehydrate, recall, checkpoint, redact secrets, and gate incomplete tasks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-memory-hook-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-memory-hook-data-"));
  const store = new MemoryStore(data);
  const project = resolveProject(cwd);
  const task = store.upsertTask(project, {
    title: "Long refactor", goal: "Finish safely",
    acceptance_criteria: ["tests pass"], next_steps: ["run tests"], gate_enabled: true
  });
  store.storeMemory(project, {
    task_id: task.id, kind: "failure", summary: "Old approach failed",
    content: "Do not retry LegacyBuilder because it corrupts fixtures",
    authority: "historical_attempt", symbol: "LegacyBuilder", importance: 0.9
  });
  store.close();

  const start = invoke({ session_id: "s1", cwd, hook_event_name: "SessionStart", source: "resume" }, data, cwd);
  assert.match(start.hookSpecificOutput.additionalContext, /Long refactor/);
  const recall = invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "run LegacyBuilder" } }, data, cwd);
  assert.match(recall.hookSpecificOutput.additionalContext, /corrupts fixtures/);
  invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tool1", tool_input: { command: "test", token: "sk-abcdefghijklmnopqrstuvwxyz" }, tool_response: { exit_code: 1, output: "FATAL error CS0117 sk-abcdefghijklmnopqrstuvwxyz" } }, data, cwd);
  invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PreCompact", trigger: "auto" }, data, cwd);
  const stop = invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "Stop", stop_hook_active: false }, data, cwd);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /tests pass/);

  const check = new MemoryStore(data);
  const status = check.status(project);
  assert.equal(status.counts.checkpoints, 1);
  const payload = check.db.prepare("SELECT payload FROM events WHERE tool_use_id='tool1'").get().payload;
  assert.doesNotMatch(payload, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(payload, /REDACTED/);
  check.upsertTask(project, { task_id: task.id, completed_items: ["tests pass"], next_steps: [], blockers: [] });
  check.close();
  const allowed = invoke({ session_id: "s1", turn_id: "t2", cwd, hook_event_name: "Stop", stop_hook_active: false }, data, cwd);
  assert.deepEqual(allowed, {});
});

test("integrated Hook merges project memory with role initialization and policy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-integrated-hook-project-"));
  const memoryData = mkdtempSync(join(tmpdir(), "codex-integrated-memory-data-"));
  const roleData = mkdtempSync(join(tmpdir(), "codex-integrated-role-data-"));
  const memory = new MemoryStore(memoryData); const project = resolveProject(cwd);
  const task = memory.upsertTask(project, { title: "Integrated task", goal: "Prove both control planes", next_steps: ["continue"] });
  memory.storeMemory(project, { task_id: task.id, kind: "constraint", summary: "Protected boundary", content: "Do not edit generated files", authority: "project_authority", importance: 1 });
  memory.close();

  const env = { ...process.env, CODEX_PROJECT_MEMORY_HOME: memoryData, CODEX_ROLE_RUNTIME_HOME: roleData, CODEX_ROLE_RUNTIME_TEST_COORDINATOR_THREAD: "thr-integrated-coordinator" };
  const invokeIntegrated = (input) => {
    const run = spawnSync(process.execPath, ["--no-warnings", integratedHookPath], { cwd, env, input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); return run.stdout.trim() ? JSON.parse(run.stdout) : {};
  };
  const initialized = invokeIntegrated({ session_id: "thr-integrated-user", turn_id: "t0", cwd, hook_event_name: "UserPromptSubmit", prompt: "初始化角色编排" });
  assert.match(initialized.hookSpecificOutput.additionalContext, /communication entry point/);
  const resumed = invokeIntegrated({ session_id: "thr-integrated-user", cwd, hook_event_name: "SessionStart", source: "resume" });
  assert.match(resumed.hookSpecificOutput.additionalContext, /Integrated task/);
  assert.match(resumed.hookSpecificOutput.additionalContext, /role:\/\/liaison/);

  const roleStore = new (await import("../dist/role-library.mjs")).RoleStore(roleData);
  const roleProject = (await import("../dist/role-library.mjs")).resolveProject(cwd);
  assert.equal(roleStore.activeGeneration(roleProject, "coordinator").thread_id, "thr-integrated-coordinator");
  roleStore.close();
});
