import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryStore, resolveProject } from "../dist/library.mjs";

const hookPath = resolve("dist/hook.mjs");

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
