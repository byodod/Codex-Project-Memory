import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attachRoleThread, initializeStandardTopology, prepareLiaisonRequest, recordLiaisonResult, RoleStore, resolveProject, routeRoleMessage } from "../dist/library.mjs";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "codex-role-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-role-data-"));
  const store = new RoleStore(data); const project = resolveProject(cwd);
  store.configureProject(project, "Keep domains modular.");
  store.defineRole(project, { role_key: "architect", kind: "governance", mission: "Protect boundaries.", owned_domains: ["architecture"], policy: { mode: "read_only" } });
  store.defineRole(project, { role_key: "implementer", kind: "worker", mission: "Implement bounded changes.", owned_domains: ["implementation"], policy: { mode: "workspace_write", allowedWriteGlobs: ["^src/"] } });
  return { cwd, data, store, project };
}

test("standard topology makes liaison the coordinator-only user gateway", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-role-topology-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-role-topology-data-"));
  const store = new RoleStore(data); const project = resolveProject(cwd);
  try {
    assert.equal(initializeStandardTopology(store, project).entry_role, "liaison");
    assert.equal(initializeStandardTopology(store, project).roles.length, 4);
    store.bindInitial(project, "liaison", "thr-liaison");
    attachRoleThread(store, project, "coordinator", "thr-coordinator");
    const request = store.sendMessage(project, { type: "ASSIGN", from_role: "liaison", to_role: "coordinator", from_generation: 1, architecture_epoch: 1, payload: { intent: "Build" } });
    assert.equal(request.to_role, "coordinator");
    assert.throws(() => store.sendMessage(project, { type: "QUESTION", from_role: "liaison", to_role: "architect", from_generation: 1, architecture_epoch: 1, payload: {} }), /LIAISON_ROUTE_REQUIRES_COORDINATOR/);
  } finally { store.close(); }
});

test("database enforces one active generation and immutable task identity", () => {
  const { store, project } = fixture();
  try {
    const first = store.bindInitial(project, "architect", "thr-a");
    assert.throws(() => store.bindInitial(project, "architect", "thr-b"), /ROLE_ALREADY_HAS_ACTIVE_GENERATION/);
    assert.throws(() => store.bindInitial(project, "implementer", "thr-a"), /THREAD_ALREADY_BOUND/);
    assert.throws(() => store.db.prepare("UPDATE role_generations SET thread_id='thr-mutated' WHERE id=?").run(first.id), /THREAD_BINDING_IMMUTABLE/);
  } finally { store.close(); }
});

test("role_attach is idempotent and directly replaces an unavailable or archived task", () => {
  const { store, project } = fixture();
  try {
    const first = attachRoleThread(store, project, "architect", "thr-desktop-1");
    assert.equal(first.generation.generation_number, 1);
    assert.equal(attachRoleThread(store, project, "architect", "thr-desktop-1").attached, false);
    const replacement = attachRoleThread(store, project, "architect", "thr-desktop-2", "Desktop reported the old task archived.");
    assert.equal(replacement.generation.generation_number, 2);
    assert.equal(store.activeGeneration(project, "architect").thread_id, "thr-desktop-2");
    assert.equal(store.getGenerationByThread(project, "thr-desktop-1").generation.status, "retired");
  } finally { store.close(); }
});

test("role_attach supersedes interrupted local rotation bookkeeping", () => {
  const { store, project } = fixture();
  try {
    store.bindInitial(project, "architect", "thr-old");
    const stale = store.createRotation(project, "architect", "interrupted");
    const candidate = store.createCandidate(project, "architect", "thr-abandoned");
    store.updateRotation(stale.id, "BOOTSTRAPPING", { candidateId: candidate.id });
    const attached = attachRoleThread(store, project, "architect", "thr-new");
    assert.equal(attached.generation.thread_id, "thr-new");
    assert.equal(store.getGenerationByThread(project, "thr-abandoned").generation.status, "rejected");
    assert.equal(store.db.prepare("SELECT state FROM rotations WHERE id=?").get(stale.id).state, "FAILED");
  } finally { store.close(); }
});

test("typed routing persists exactly once and returns desktop route without hidden wake", () => {
  const { store, project } = fixture();
  try {
    store.bindInitial(project, "architect", "thr-a");
    const input = { message_id: "msg-fixed", type: "ASSIGN", from_role: "architect", to_role: "implementer", from_generation: 1, architecture_epoch: 1, payload: { task: "T1" } };
    const first = routeRoleMessage(store, project, input);
    const repeated = routeRoleMessage(store, project, input);
    assert.equal(first.recipient.status, "needs_task");
    assert.equal(first.dispatch, "desktop_task_tools");
    assert.equal(repeated.message.id, first.message.id);
    assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE id='msg-fixed'").get().n, 1);
    attachRoleThread(store, project, "implementer", "thr-i");
    const routed = routeRoleMessage(store, project, { ...input, message_id: "msg-routed" });
    assert.equal(routed.recipient.thread_id, "thr-i");
    assert.equal(store.message(project, "msg-routed").wake_status, "idle");
  } finally { store.close(); }
});

test("Liaison request is dispatched by desktop tools and result recording is idempotent", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-role-liaison-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-role-liaison-data-"));
  const store = new RoleStore(data); const project = resolveProject(cwd);
  initializeStandardTopology(store, project);
  store.bindInitial(project, "liaison", "thr-liaison");
  try {
    const beforeAttach = prepareLiaisonRequest(store, project, { liaison_generation: 1, request: "Initialize.", message_id: "req-1" });
    assert.equal(beforeAttach.recipient.status, "needs_task");
    assert.match(beforeAttach.prompt, /durable request/);
    attachRoleThread(store, project, "coordinator", "thr-coordinator");
    const routed = prepareLiaisonRequest(store, project, { liaison_generation: 1, request: "Initialize.", message_id: "req-1" });
    assert.equal(routed.recipient.thread_id, "thr-coordinator");
    const result = recordLiaisonResult(store, project, { request_message_id: "req-1", response: "Ready." });
    const repeated = recordLiaisonResult(store, project, { request_message_id: "req-1", response: "Ready." });
    assert.equal(result.result_message.id, "result:req-1");
    assert.equal(repeated.result_message.id, result.result_message.id);
    assert.equal(store.message(project, "req-1").status, "acknowledged");
    assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE reply_to='req-1'").get().n, 1);
  } finally { store.close(); }
});

test("stale generation, architecture, and message ids are rejected", () => {
  const { store, project } = fixture();
  try {
    store.bindInitial(project, "architect", "thr-a");
    store.bindInitial(project, "implementer", "thr-i");
    const input = { message_id: "msg-fixed", type: "ASSIGN", from_role: "architect", to_role: "implementer", from_generation: 1, architecture_epoch: 1, payload: { task: "T1" } };
    store.sendMessage(project, input);
    assert.throws(() => store.sendMessage(project, { ...input, payload: { task: "different" } }), /MESSAGE_ID_CONFLICT/);
    store.advanceArchitecture(project, "new boundary");
    assert.throws(() => store.sendMessage(project, { ...input, message_id: "stale" }), /STALE_ARCHITECTURE_EPOCH/);
  } finally { store.close(); }
});

test("legacy role-fact uniqueness migrates without losing provenance", () => {
  const data = mkdtempSync(join(tmpdir(), "codex-role-legacy-"));
  const legacy = new DatabaseSync(join(data, "role-runtime.sqlite3"));
  legacy.exec(`CREATE TABLE role_facts (id TEXT PRIMARY KEY, role_id TEXT NOT NULL, fact_key TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, authority TEXT NOT NULL, source TEXT, architecture_epoch INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(role_id, fact_key, status))`);
  legacy.close();
  const store = new RoleStore(data);
  try {
    assert.doesNotMatch(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='role_facts'").get().sql, /UNIQUE\(role_id, fact_key, status\)/);
  } finally { store.close(); }
});

test("role reset deletes only the resolved project's full control-plane graph", () => {
  const { store, project } = fixture();
  try {
    store.bindInitial(project, "architect", "thr-reset");
    const task = store.upsertTask(project, { owner_role: "architect", title: "Reset me", goal: "Populate graph" });
    store.createEnvelope(project, { task_id: task.id, owner_role: "architect", intent: "Populate", allowed_scope: ["^src/"] });
    store.sendMessage(project, { type: "ASSIGN", from_role: "architect", to_role: "implementer", from_generation: 1, architecture_epoch: 1, task_id: task.id, payload: {} });
    const reset = store.resetProject(project);
    assert.equal(reset.deleted, true);
    assert.equal(store.db.prepare("SELECT count(*) n FROM projects WHERE id=?").get(project.id).n, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM messages").get().n, 0);
  } finally { store.close(); }
});

test("structured role state and change envelopes preserve modular scope", () => {
  const { store, project } = fixture();
  try {
    store.putFact(project, "architect", { fact_key: "storage-boundary", kind: "invariant", content: "Storage owns inventory.", authority: "project_authority" });
    store.putFact(project, "architect", { fact_key: "storage-boundary", kind: "invariant", content: "Only Storage owns inventory.", authority: "project_authority" });
    assert.equal(store.listFacts(project, "architect", "invariant").length, 1);
    const task = store.upsertTask(project, { owner_role: "implementer", title: "Bounded patch", goal: "Change implementation only", scope: "src/" });
    const envelope = store.createEnvelope(project, { task_id: task.id, owner_role: "implementer", intent: "Patch", allowed_scope: ["^src/"] });
    assert.equal(store.checkEnvelope(project, envelope.id, ["src/a.ts"]).status, "passed");
    assert.deepEqual(store.checkEnvelope(project, envelope.id, ["docs/a.md"]).violations, ["docs/a.md"]);
  } finally { store.close(); }
});
