import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { RoleStore, resolveProject } from "../dist/library.mjs";

const hook = resolve("dist/hook.mjs");
function invoke(cwd, data, input) {
  const run = spawnSync(process.execPath, ["--no-warnings", hook], { cwd, env: { ...process.env, CODEX_ROLE_RUNTIME_HOME: data }, input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); return run.stdout.trim() ? JSON.parse(run.stdout) : {};
}

test("hook claims role, injects anchor, enforces read-only policy, and counts compact idempotently", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-role-hook-project-")); const data = mkdtempSync(join(tmpdir(), "codex-role-hook-data-"));
  const store = new RoleStore(data); const project = resolveProject(cwd);
  store.defineRole(project, { role_key: "architect", mission: "Protect boundaries.", owned_domains: ["architecture"], policy: { mode: "read_only" } }); store.close();

  const claim = invoke(cwd, data, { session_id: "thr-a", turn_id: "t0", cwd, hook_event_name: "UserPromptSubmit", prompt: "role://bind architect" });
  assert.match(claim.hookSpecificOutput.additionalContext, /role:\/\/architect/);
  const start = invoke(cwd, data, { session_id: "thr-a", cwd, hook_event_name: "SessionStart", source: "resume" });
  assert.match(start.hookSpecificOutput.additionalContext, /Protect boundaries/);
  const denied = invoke(cwd, data, { session_id: "thr-a", turn_id: "t1", tool_use_id: "u1", cwd, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  const shellDenied = invoke(cwd, data, { session_id: "thr-a", turn_id: "t1", tool_use_id: "u2", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "Remove-Item file.txt" } });
  assert.equal(shellDenied.hookSpecificOutput.permissionDecision, "deny");
  const shellRead = invoke(cwd, data, { session_id: "thr-a", turn_id: "t1", tool_use_id: "u3", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status --short" } });
  assert.notEqual(shellRead.hookSpecificOutput?.permissionDecision, "deny");

  invoke(cwd, data, { session_id: "thr-a", turn_id: "c1", cwd, hook_event_name: "PostCompact", trigger: "auto" });
  invoke(cwd, data, { session_id: "thr-a", turn_id: "c1", cwd, hook_event_name: "PostCompact", trigger: "auto" });
  let check = new RoleStore(data); assert.equal(check.activeGeneration(project, "architect").compact_count, 1); check.close();
  invoke(cwd, data, { session_id: "thr-a", turn_id: "c2", cwd, hook_event_name: "PostCompact", trigger: "auto" });
  check = new RoleStore(data); assert.equal(check.activeGeneration(project, "architect").health, "rotation_required"); check.close();
});

test("retired generation prompt and tool calls are blocked", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-role-stale-project-")); const data = mkdtempSync(join(tmpdir(), "codex-role-stale-data-"));
  const store = new RoleStore(data); const project = resolveProject(cwd);
  store.defineRole(project, { role_key: "owner", mission: "Own domain.", policy: { mode: "workspace_write" } });
  store.bindInitial(project, "owner", "thr-old"); const candidate = store.createCandidate(project, "owner", "thr-new");
  store.activateCandidate(project, "owner", candidate.id, "rotate"); store.close();
  const prompt = invoke(cwd, data, { session_id: "thr-old", turn_id: "t1", cwd, hook_event_name: "UserPromptSubmit", prompt: "continue" });
  assert.equal(prompt.decision, "block"); assert.match(prompt.reason, /STALE_GENERATION/);
  const tool = invoke(cwd, data, { session_id: "thr-old", turn_id: "t1", tool_use_id: "u1", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } });
  assert.equal(tool.hookSpecificOutput.permissionDecision, "deny");
});
