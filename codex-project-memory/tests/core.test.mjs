import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, resolveProject } from "../dist/library.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-memory-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-memory-data-"));
  const store = new MemoryStore(data);
  const project = resolveProject(root);
  return { root, data, store, project };
}

test("task snapshots enforce acceptance, blockers, and open steps", () => {
  const { store, project } = fixture();
  try {
    const task = store.upsertTask(project, {
      title: "Ship save migration",
      goal: "Migrate saves without losing data",
      acceptance_criteria: ["unit tests pass", "migration smoke passes"],
      completed_items: ["unit tests pass"],
      next_steps: ["run migration smoke"],
      gate_enabled: true
    });
    assert.deepEqual(store.completionIssues(task), [
      "未满足验收标准：migration smoke passes",
      "仍有下一步：run migration smoke"
    ]);
    assert.throws(() => store.completeTask(project, task.id), /cannot be completed/i);
    store.upsertTask(project, {
      task_id: task.id,
      completed_items: ["unit tests pass", "migration smoke passes"],
      next_steps: [], blockers: []
    });
    const completed = store.completeTask(project, task.id, "All acceptance criteria verified.");
    assert.equal(completed.status, "completed");
  } finally {
    store.close();
  }
});

test("FTS retrieval boosts exact symbols and supersession hides stale decisions", () => {
  const { store, project, data } = fixture();
  try {
    const old = store.storeMemory(project, {
      kind: "decision",
      summary: "Old serializer",
      content: "Use JSON v1 for saves",
      authority: "project_authority",
      source_note: "ADR-001",
      symbol: "SaveAtMidpoint_ThenContinue_MatchesFullRun",
      importance: 0.9,
      verified: true
    });
    store.storeMemory(project, {
      kind: "note",
      summary: "Nearby note",
      content: "Save tests exist",
      authority: "agent_inference",
      symbol: "SaveRunner"
    });
    const first = store.search(project, "SaveAtMidpoint_ThenContinue_MatchesFullRun", { limit: 5 });
    assert.equal(first[0].id, old.id);
    const lineage = store.supersede(project, old.id, {
      kind: "decision",
      summary: "Current serializer",
      content: "Use protobuf for saves",
      authority: "user_decision",
      source_note: "User explicitly selected protobuf",
      symbol: "SaveAtMidpoint_ThenContinue_MatchesFullRun",
      importance: 1
    });
    const current = store.search(project, "SaveAtMidpoint_ThenContinue_MatchesFullRun", { limit: 5 });
    assert.equal(current[0].id, lineage.replacement.id);
    assert.ok(!current.some((item) => item.id === old.id));
    const exported = readFileSync(join(data, "projects", project.id, "MEMORY.md"), "utf8");
    assert.match(exported, /Use protobuf for saves/);
    assert.doesNotMatch(exported, /Use JSON v1 for saves/);
  } finally {
    store.close();
  }
});

test("FTS relevance is not discarded by authority boosts and returned recall metadata is current", () => {
  const { store, project } = fixture();
  try {
    store.storeMemory(project, {
      kind: "decision", summary: "Generic Hook policy", content: "Hooks are enabled for this project.",
      authority: "user_decision", importance: 1
    });
    const failure = store.storeMemory(project, {
      kind: "failure", summary: "Generator bootstrap timeout", content: "the bootstrap command left a pending candidate after a timeout and recursive retry",
      authority: "tool_observation", importance: 1
    });
    const results = store.search(project, "generator bootstrap timeout recursive retry candidate", { limit: 5 });
    assert.equal(results[0].id, failure.id);
    assert.equal(results[0].recall_count, 1);
    assert.ok(results[0].last_recalled_at);
    assert.equal(store.getMemory(project, failure.id).recall_count, 1);
  } finally { store.close(); }
});

test("consolidation previews and archives only exact normalized duplicates", () => {
  const { store, project } = fixture();
  try {
    for (let index = 0; index < 2; index++) {
      store.storeMemory(project, {
        kind: "tool_quirk",
        summary: `Build order ${index}`,
        content: "Run generator before build",
        authority: "tool_observation"
      });
    }
    const preview = store.consolidate(project, false);
    assert.equal(preview.exact_duplicates.length, 1);
    assert.equal(store.consolidate(project, true).changed, 1);
    assert.equal(store.search(project, "Run generator before build", { limit: 10 }).length, 1);
  } finally {
    store.close();
  }
});

test("project reset removes every memory record and its human-readable export", () => {
  const { store, project, data } = fixture();
  try {
    const task = store.upsertTask(project, { title: "Disposable", goal: "Populate all reset tables" });
    store.storeMemory(project, { task_id: task.id, kind: "note", summary: "Disposable", content: "Delete me", authority: "agent_inference" });
    store.recordEvent(project, { taskId: task.id, eventType: "test" });
    store.recordVerification(project, { taskId: task.id, status: "passed", evidence: "test" });
    store.checkpoint(project, { taskId: task.id, trigger: "test" });
    const exportDirectory = join(data, "projects", project.id);
    assert.equal(existsSync(exportDirectory), true);

    const reset = store.resetProject(project);
    assert.equal(reset.deleted, true);
    assert.deepEqual(reset.counts, { plans: 0, tasks: 1, memories: 1, events: 1, verifications: 1, checkpoints: 1 });
    assert.equal(existsSync(exportDirectory), false);
    assert.equal(store.db.prepare("SELECT count(*) n FROM projects WHERE id=?").get(project.id).n, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM memories WHERE project_id=?").get(project.id).n, 0);
  } finally { store.close(); }
});
