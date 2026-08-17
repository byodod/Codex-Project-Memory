import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
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
  const plan = store.upsertPlan(project, {
    project_goal: "Preserve the mainline",
    definition_of_done: ["tests pass"],
    current_milestone: "hook recovery"
  });
  const task = store.upsertTask(project, {
    plan_id: plan.id,
    title: "Long refactor", goal: "Finish safely",
    acceptance_criteria: ["tests pass"], next_steps: ["run tests"],
    exact_next_action: "run npm test", gate_enabled: true
  });
  store.storeMemory(project, {
    task_id: task.id, kind: "failure", summary: "Old approach failed",
    content: "Do not retry LegacyBuilder because it corrupts fixtures",
    authority: "historical_attempt", symbol: "LegacyBuilder", importance: 0.9
  });
  store.close();

  const start = invoke({ session_id: "s1", cwd, hook_event_name: "SessionStart", source: "resume" }, data, cwd);
  assert.match(start.hookSpecificOutput.additionalContext, /Long refactor/);
  const compactStart = invoke({ session_id: "s1", cwd, hook_event_name: "SessionStart", source: "compact" }, data, cwd);
  assert.match(compactStart.hookSpecificOutput.additionalContext, /Project Memory Mainline Capsule/);
  assert.match(compactStart.hookSpecificOutput.additionalContext, /Long refactor/);
  assert.match(compactStart.hookSpecificOutput.additionalContext, /Exact next action: run npm test/);
  assert.ok(compactStart.hookSpecificOutput.additionalContext.length <= 6000);
  const recall = invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "run LegacyBuilder" } }, data, cwd);
  assert.match(recall.hookSpecificOutput.additionalContext, /corrupts fixtures/);
  invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tool1", tool_input: { command: "test", token: "sk-abcdefghijklmnopqrstuvwxyz" }, tool_response: { exit_code: 1, output: "FATAL error CS0117 sk-abcdefghijklmnopqrstuvwxyz" } }, data, cwd);
  invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PreCompact", trigger: "auto" }, data, cwd);
  invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PreCompact", trigger: "auto" }, data, cwd);
  assert.equal(invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PostCompact", trigger: "auto" }, data, cwd), null);
  const restored = invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "SessionStart", source: "compact" }, data, cwd);
  assert.match(restored.hookSpecificOutput.additionalContext, /Checkpoint: checkpoint_/);
  const stop = invoke({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "Stop", stop_hook_active: false }, data, cwd);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /tests pass/);

  const check = new MemoryStore(data);
  const status = check.status(project);
  assert.equal(status.counts.checkpoints, 1);
  assert.equal(check.db.prepare("SELECT count(*) n FROM events WHERE event_type='post_compact'").get().n, 1);
  const payload = check.db.prepare("SELECT payload FROM events WHERE tool_use_id='tool1'").get().payload;
  assert.doesNotMatch(payload, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(payload, /REDACTED/);
  check.upsertTask(project, { task_id: task.id, completed_items: ["tests pass"], next_steps: [], blockers: [] });
  check.close();
  const allowed = invoke({ session_id: "s1", turn_id: "t2", cwd, hook_event_name: "Stop", stop_hook_active: false }, data, cwd);
  assert.deepEqual(allowed, {});
});

test("PreCompact never blocks on storage startup failure and SessionStart can use the last good capsule", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-memory-hook-fallback-project-"));
  const badHome = join(mkdtempSync(join(tmpdir(), "codex-memory-hook-bad-home-")), "not-a-directory");
  writeFileSync(badHome, "file", "utf8");
  assert.equal(invoke({ session_id: "s2", cwd, hook_event_name: "PreCompact", trigger: "auto" }, badHome, cwd), null);

  const data = mkdtempSync(join(tmpdir(), "codex-memory-hook-fallback-data-"));
  const store = new MemoryStore(data);
  const project = resolveProject(cwd);
  const plan = store.upsertPlan(project, { project_goal: "Recover from the last valid checkpoint" });
  const task = store.upsertTask(project, { plan_id: plan.id, title: "Fallback", goal: "Keep going", exact_next_action: "resume safely" });
  store.checkpoint(project, { taskId: task.id, trigger: "fallback-test" });
  const databasePath = store.databasePath;
  store.close();
  renameSync(databasePath, `${databasePath}.bak`);
  mkdirSync(databasePath);

  const restored = invoke({ session_id: "s3", cwd, hook_event_name: "SessionStart", source: "compact" }, data, cwd);
  assert.match(restored.hookSpecificOutput.additionalContext, /Recovery: degraded/);
  assert.match(restored.hookSpecificOutput.additionalContext, /Exact next action: resume safely/);
});
