import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
      kind: "failure", summary: "Coordinator bootstrap timeout", content: "role_start left a bootstrapping candidate after a coordinator timeout and recursive retry",
      authority: "tool_observation", importance: 1
    });
    const results = store.search(project, "coordinator bootstrap timeout recursive role_start candidate", { limit: 5 });
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
