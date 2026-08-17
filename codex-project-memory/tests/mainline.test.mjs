import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, renderMainlineCapsule, resolveProject } from "../dist/library.mjs";

function fixture(prefix = "codex-memory-mainline-") {
  const root = mkdtempSync(join(tmpdir(), `${prefix}project-`));
  const data = mkdtempSync(join(tmpdir(), `${prefix}data-`));
  const store = new MemoryStore(data);
  return { root, data, store, project: resolveProject(root) };
}

test("plan and work-item revisions are idempotent and produce a deterministic mainline without curated memory", () => {
  const { store, project, data } = fixture();
  try {
    const plan = store.upsertPlan(project, {
      title: "Ship durable recovery",
      project_goal: "Keep the implementation mainline across compaction",
      definition_of_done: ["compact continuation resumes the exact next action"],
      current_milestone: "M2 compact recovery",
      critical_constraints: ["Do not summarize a previous capsule"],
      open_user_decisions: []
    });
    const samePlan = store.upsertPlan(project, {
      plan_id: plan.id,
      expected_revision: 1,
      project_goal: "Keep the implementation mainline across compaction"
    });
    assert.equal(samePlan.revision, 1);
    assert.throws(() => store.upsertTask(project, { task_id: "task_invalid", plan_id: "plan_missing", title: "Invalid" }), /PLAN_NOT_FOUND/);

    const task = store.upsertTask(project, {
      plan_id: plan.id,
      title: "Implement capsule",
      goal: "Render canonical state",
      acceptance_criteria: ["capsule is bounded"],
      next_steps: ["add renderer tests"],
      milestone: "M2 compact recovery"
    });
    const sameTask = store.upsertTask(project, { task_id: task.id, next_steps: ["add renderer tests"] });
    assert.equal(sameTask.version, 1);

    const capsule = store.mainlineCapsule(project);
    assert.equal(capsule.active_plan.revision, 1);
    assert.equal(capsule.active_work_item.version, 1);
    assert.equal(capsule.exact_next_action, "[derived] add renderer tests");
    assert.equal(capsule.blockers, "NONE");
    assert.equal(capsule.open_user_decisions, "NONE");
    assert.equal(capsule.latest_valid_verification.freshness, "NONE_CURRENT");
    assert.equal(store.status(project).counts.active_memories, 0);

    const checkpoint = store.checkpoint(project, { taskId: task.id, trigger: "test" });
    const repeated = store.checkpoint(project, { taskId: task.id, trigger: "test-again" });
    assert.equal(repeated.id, checkpoint.id);
    assert.equal(repeated.reused, true);
    assert.equal(store.status(project).counts.checkpoints, 1);
    assert.equal(existsSync(join(data, "projects", project.id, "last_good_capsule.json")), true);
    assert.equal(existsSync(join(data, "projects", project.id, "MAINLINE.md")), true);

    const rendered = renderMainlineCapsule(store.mainlineCapsule(project), 6000);
    assert.match(rendered, /Project Memory Mainline Capsule/);
    assert.match(rendered, /Exact next action: \[derived\] add renderer tests/);
    assert.ok(rendered.length <= 6000);
    const fallback = store.readLastGoodCapsule(project);
    assert.equal(fallback.recovery_mode, "degraded");
    const fallbackPath = join(data, "projects", project.id, "last_good_capsule.json");
    const tampered = JSON.parse(readFileSync(fallbackPath, "utf8"));
    tampered.capsule.project_goal = "tampered without a matching digest";
    writeFileSync(fallbackPath, JSON.stringify(tampered), "utf8");
    assert.equal(store.readLastGoodCapsule(project), null);
  } finally { store.close(); }
});

test("verification freshness is bound to plan revision, task version, Git revision, and workspace digest", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-memory-git-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-memory-git-data-"));
  writeFileSync(join(root, "tracked.txt"), "v1\n", "utf8");
  for (const args of [
    ["init"], ["add", "tracked.txt"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]
  ]) {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  }
  const store = new MemoryStore(data);
  try {
    const clean = resolveProject(root);
    const plan = store.upsertPlan(clean, { project_goal: "Keep verification honest" });
    const task = store.upsertTask(clean, { plan_id: plan.id, title: "Verify", goal: "Bind evidence" });
    const verification = store.recordVerification(clean, { taskId: task.id, command: "npm test", status: "passed", evidence: "all tests passed" });
    assert.equal(verification.freshness, "CURRENT");

    const revisedPlan = store.upsertPlan(clean, { plan_id: plan.id, expected_revision: 1, current_milestone: "revised milestone" });
    assert.equal(revisedPlan.revision, 2);
    assert.equal(store.listVerifications(clean, task.id)[0].freshness, "STALE");
    const reboundTask = store.upsertTask(clean, { task_id: task.id, exact_next_action: "reverify revised plan" });
    assert.equal(reboundTask.version, 2);
    assert.equal(reboundTask.plan_revision, 2);
    assert.equal(store.recordVerification(clean, { taskId: task.id, command: "npm test", status: "passed", evidence: "reverified" }).freshness, "CURRENT");

    writeFileSync(join(root, "tracked.txt"), "v2\n", "utf8");
    const dirty = resolveProject(root);
    assert.equal(dirty.repositoryState, "dirty");
    assert.equal(store.listVerifications(dirty, task.id)[0].freshness, "STALE");

    const updatedTask = store.upsertTask(dirty, { task_id: task.id, exact_next_action: "re-run npm test" });
    assert.equal(updatedTask.version, 3);
    assert.equal(store.mainlineCapsule(dirty).latest_valid_verification.freshness, "STALE");
  } finally { store.close(); }
});

test("existing v1 databases migrate in place without losing active tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-memory-migration-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-memory-migration-data-"));
  const project = resolveProject(root);
  const db = new DatabaseSync(join(data, "project-memory.sqlite3"));
  const timestamp = new Date().toISOString();
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, remote TEXT, git_common_dir TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, branch TEXT, base_revision TEXT,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]', completed_items TEXT NOT NULL DEFAULT '[]',
      next_steps TEXT NOT NULL DEFAULT '[]', blockers TEXT NOT NULL DEFAULT '[]', notes TEXT,
      gate_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE verifications (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, criterion TEXT, command TEXT,
      status TEXT NOT NULL, evidence TEXT NOT NULL, revision TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, session_id TEXT, turn_id TEXT,
      trigger TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?)").run(project.id, project.root, project.name, null, null, timestamp, timestamp);
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "task_v1", project.id, "Legacy task", "Survive migration", "active", null, null,
    "[]", "[]", "[\"continue migration\"]", "[]", null, 1, timestamp, timestamp, null
  );
  db.close();

  const store = new MemoryStore(data);
  try {
    const task = store.getTask(project, "task_v1");
    assert.equal(task.title, "Legacy task");
    assert.equal(task.version, 1);
    assert.equal(task.plan_id, null);
    assert.equal(task.exact_next_action, null);
    const updated = store.upsertTask(project, { task_id: task.id, exact_next_action: "finish migration" });
    assert.equal(updated.version, 2);
    for (const [table, required] of [
      ["tasks", ["plan_id", "plan_revision", "milestone", "exact_next_action", "version"]],
      ["verifications", ["plan_revision", "task_version", "workspace_digest"]],
      ["checkpoints", ["schema_version", "snapshot_version", "state_digest", "capsule_digest"]]
    ]) {
      const columns = new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
      for (const column of required) assert.ok(columns.has(column), `${table}.${column} was not migrated`);
    }
  } finally { store.close(); }
});
