import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoleStore, resolveProject } from "../dist/library.mjs";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "codex-role-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-role-data-"));
  const store = new RoleStore(data); const project = resolveProject(cwd);
  store.configureProject(project, "Keep domains modular.");
  store.defineRole(project, { role_key: "architect", kind: "governance", mission: "Protect boundaries.", owned_domains: ["architecture"], policy: { mode: "read_only" } });
  store.defineRole(project, { role_key: "implementer", kind: "worker", mission: "Implement bounded changes.", owned_domains: ["implementation"], policy: { mode: "workspace_write", allowedWriteGlobs: ["^src/"] } });
  return { cwd, data, store, project };
}

test("database enforces one active generation and immutable thread identity", () => {
  const { store, project } = fixture();
  try {
    const first = store.bindInitial(project, "architect", "thr-a");
    assert.equal(first.generation_number, 1);
    assert.throws(() => store.bindInitial(project, "architect", "thr-b"), /ROLE_ALREADY_HAS_ACTIVE_GENERATION/);
    assert.throws(() => store.bindInitial(project, "implementer", "thr-a"), /THREAD_ALREADY_BOUND/);
    assert.throws(() => store.db.prepare("UPDATE role_generations SET thread_id='thr-mutated' WHERE id=?").run(first.id), /THREAD_BINDING_IMMUTABLE/);
  } finally { store.close(); }
});

test("legacy role-fact uniqueness migrates without losing provenance", () => {
  const data = mkdtempSync(join(tmpdir(), "codex-role-legacy-"));
  const legacy = new DatabaseSync(join(data, "role-runtime.sqlite3"));
  legacy.exec(`CREATE TABLE role_facts (
    id TEXT PRIMARY KEY, role_id TEXT NOT NULL, fact_key TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
    authority TEXT NOT NULL, source TEXT, architecture_epoch INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(role_id, fact_key, status)
  )`);
  legacy.close();
  const store = new RoleStore(data);
  try {
    const sql = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='role_facts'").get().sql;
    assert.doesNotMatch(sql, /UNIQUE\(role_id, fact_key, status\)/);
    assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_one_active_role_fact'").get().sql, /WHERE status='active'/);
  } finally { store.close(); }
});

test("candidate remains non-active until validated atomic cutover and old writes become stale", () => {
  const { store, project, data } = fixture();
  const old = store.bindInitial(project, "architect", "thr-old");
  const rotation = store.createRotation(project, "architect", "milestone complete");
  const candidate = store.createCandidate(project, "architect", "thr-new", "hash");
  store.updateRotation(rotation.id, "BOOTSTRAPPING", { candidateId: candidate.id });
  assert.equal(store.activeGeneration(project, "architect").thread_id, "thr-old");
  store.close();

  const reopened = new RoleStore(data);
  try {
    assert.equal(reopened.activeGeneration(project, "architect").thread_id, "thr-old", "crash recovery keeps old generation active");
    const expected = { role_id: "architect", mission: "Protect boundaries.", owned_domains: ["architecture"], critical_invariants: [], open_questions: [], architecture_epoch: 1 };
    assert.deepEqual(reopened.validateBootstrap(project, "architect", expected), { ok: true, errors: [] });
    const active = reopened.activateCandidate(project, "architect", candidate.id, "validated");
    assert.equal(active.thread_id, "thr-new");
    assert.equal(reopened.getGenerationByThread(project, "thr-old").generation.status, "retired");
    assert.throws(() => reopened.assertCurrent(reopened.getRole(project, "architect"), old.generation_number), /STALE_GENERATION/);
  } finally { reopened.close(); }
});

test("typed messages are idempotent and reject stale generation or architecture", () => {
  const { store, project } = fixture();
  try {
    store.bindInitial(project, "architect", "thr-a");
    store.bindInitial(project, "implementer", "thr-i");
    const input = { message_id: "msg-fixed", type: "ASSIGN", from_role: "architect", to_role: "implementer", from_generation: 1, architecture_epoch: 1, scope: "src/", payload: { task: "T1" } };
    store.sendMessage(project, input); store.sendMessage(project, input);
    assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE id='msg-fixed'").get().n, 1);
    assert.equal(store.inbox(project, "implementer").length, 1);
    store.acknowledgeMessage(project, "implementer", "msg-fixed");
    store.advanceArchitecture(project, "new boundary");
    assert.throws(() => store.sendMessage(project, { ...input, message_id: "msg-stale", architecture_epoch: 1 }), /STALE_ARCHITECTURE_EPOCH/);
  } finally { store.close(); }
});

test("structured role state, task graph, and change envelopes preserve modular scope", () => {
  const { store, project } = fixture();
  try {
    store.putFact(project, "architect", { fact_key: "storage-boundary", kind: "invariant", content: "Storage owns settled inventory.", authority: "project_authority", source: "ADR-1" });
    store.putFact(project, "architect", { fact_key: "storage-boundary", kind: "invariant", content: "Storage exclusively owns settled inventory.", authority: "project_authority", source: "ADR-2" });
    store.putFact(project, "architect", { fact_key: "storage-boundary", kind: "invariant", content: "Only Storage accepts settled inventory.", authority: "project_authority", source: "ADR-3" });
    assert.equal(store.listFacts(project, "architect", "invariant").length, 1);
    assert.equal(store.db.prepare("SELECT count(*) n FROM role_facts WHERE fact_key='storage-boundary'").get().n, 3);
    const task = store.upsertTask(project, { owner_role: "implementer", title: "Bounded patch", goal: "Change implementation only", scope: "src/", acceptance_criteria: ["tests pass"] });
    const envelope = store.createEnvelope(project, { task_id: task.id, owner_role: "implementer", intent: "Patch implementation", allowed_scope: ["^src/"], tests: ["npm test"] });
    assert.equal(store.checkEnvelope(project, envelope.id, ["src/a.ts"]).status, "passed");
    const violated = store.checkEnvelope(project, envelope.id, ["src/a.ts", "docs/adr.md"]);
    assert.equal(violated.status, "violated"); assert.deepEqual(violated.violations, ["docs/adr.md"]);
    assert.equal(store.taskGraph(project).length, 1);
  } finally { store.close(); }
});
