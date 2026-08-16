import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStandardTopology, RoleStore, resolveProject, rotateRoleGeneration, startRoleGeneration } from "../dist/library.mjs";

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
    const first = initializeStandardTopology(store, project);
    const second = initializeStandardTopology(store, project);
    assert.equal(first.entry_role, "liaison");
    assert.equal(second.roles.length, 4);
    assert.equal(store.listRoles(project).length, 4);
    store.bindInitial(project, "liaison", "thr-liaison");
    store.bindInitial(project, "coordinator", "thr-coordinator");
    const request = store.sendMessage(project, { type: "ASSIGN", from_role: "liaison", to_role: "coordinator", from_generation: 1, architecture_epoch: 1, payload: { intent: "Build the requested feature" } });
    assert.equal(request.to_role, "coordinator");
    assert.throws(() => store.sendMessage(project, { type: "QUESTION", from_role: "liaison", to_role: "architect", from_generation: 1, architecture_epoch: 1, payload: { question: "Talk to the user directly?" } }), /LIAISON_ROUTE_REQUIRES_COORDINATOR/);
    assert.match(store.roleAnchor(project, "liaison"), /sole conversational entry point/);
  } finally { store.close(); }
});

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

test("role_start activates deterministically and repeated calls are idempotent", async () => {
  const { store, project } = fixture();
  const calls = [];
  const client = {
    async startThread(input) { calls.push(input); return "thr-started"; },
    close() { calls.push("closed"); }
  };
  try {
    const started = await startRoleGeneration(store, project, "architect", { clientFactory: async () => client });
    assert.equal(started.status, "active");
    assert.equal(started.started, true);
    assert.equal(started.generation.thread_id, "thr-started");
    assert.equal(calls.filter((value) => typeof value === "object").length, 1);

    const repeated = await startRoleGeneration(store, project, "architect", { clientFactory: async () => { throw new Error("must not start another thread"); } });
    assert.equal(repeated.status, "active");
    assert.equal(repeated.started, false);
    assert.equal(repeated.generation.id, started.generation.id);
    assert.equal(store.db.prepare("SELECT count(*) n FROM role_generations WHERE role_id=?").get(store.getRole(project, "architect").id).n, 1);
  } finally { store.close(); }
});

test("failed startup rejects its candidate and a retry can create the next generation", async () => {
  const { store, project } = fixture();
  const originalActivate = store.activateCandidate.bind(store);
  store.activateCandidate = () => { throw new Error("CUTOVER_FAILED_FOR_TEST"); };
  try {
    await assert.rejects(
      rotateRoleGeneration(store, project, "architect", "initial generation", { clientFactory: async () => ({ async startThread() { return "thr-failed"; }, close() {} }) }),
      /CUTOVER_FAILED_FOR_TEST/
    );
    assert.equal(store.bootstrappingGeneration(project, "architect"), null);
    assert.equal(store.db.prepare("SELECT status FROM role_generations WHERE thread_id='thr-failed'").get().status, "rejected");
    assert.equal(store.db.prepare("SELECT state FROM rotations ORDER BY created_at DESC LIMIT 1").get().state, "FAILED");

    store.activateCandidate = originalActivate;
    const retried = await startRoleGeneration(store, project, "architect", { clientFactory: async () => ({ async startThread() { return "thr-retry"; }, close() {} }) });
    assert.equal(retried.generation.generation_number, 2);
    assert.equal(retried.generation.thread_id, "thr-retry");
  } finally { store.close(); }
});

test("role_start returns an existing in-progress candidate without duplicating it", async () => {
  const { store, project } = fixture();
  try {
    const rotation = store.createRotation(project, "architect", "initial generation");
    const candidate = store.createCandidate(project, "architect", "thr-in-progress");
    store.updateRotation(rotation.id, "BOOTSTRAPPING", { candidateId: candidate.id });
    const result = await startRoleGeneration(store, project, "architect", { clientFactory: async () => { throw new Error("must not create a duplicate"); } });
    assert.equal(result.status, "bootstrapping");
    assert.equal(result.generation.id, candidate.id);
    assert.equal(store.db.prepare("SELECT count(*) n FROM role_generations WHERE role_id=?").get(store.getRole(project, "architect").id).n, 1);
  } finally { store.close(); }
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
