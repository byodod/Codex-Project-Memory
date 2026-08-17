import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryStore, resolveProject } from "../dist/library.mjs";

test("reset-project CLI requires the exact root and clears project memory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-runtime-reset-project-"));
  const memoryData = mkdtempSync(join(tmpdir(), "codex-runtime-reset-memory-"));
  const memoryProject = resolveProject(cwd);

  const memory = new MemoryStore(memoryData);
  memory.upsertTask(memoryProject, { title: "Disposable", goal: "Reset everything" });
  memory.close();
  const cli = resolve("dist/cli.mjs");
  const env = { ...process.env, CODEX_PROJECT_MEMORY_HOME: memoryData };
  const rejected = spawnSync(process.execPath, ["--no-warnings", cli, "reset-project", "--cwd", cwd, "--confirm-root", `${cwd}-wrong`], { env, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /RESET_CONFIRMATION_REQUIRED/);

  const run = spawnSync(process.execPath, ["--no-warnings", cli, "reset-project", "--cwd", cwd, "--confirm-root", memoryProject.root], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.project_memory.deleted, true);
  assert.equal("role_runtime" in output, false);
  assert.equal(existsSync(join(memoryData, "projects", memoryProject.id)), false);

  const memoryCheck = new MemoryStore(memoryData);
  try {
    assert.equal(memoryCheck.db.prepare("SELECT count(*) n FROM projects WHERE id=?").get(memoryProject.id).n, 0);
  } finally { memoryCheck.close(); }
});
