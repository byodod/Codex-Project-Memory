import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";

test("bundled MCP server lists and calls project-memory tools over stdio", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-memory-mcp-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-memory-mcp-data-"));
  const client = new Client({ name: "project-memory-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", resolve("dist/mcp-server.mjs")],
    env: { ...process.env, CODEX_PROJECT_MEMORY_HOME: data }
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((item) => item.name));
    for (const required of ["task_get", "task_upsert", "memory_search", "memory_store", "verification_record", "task_checkpoint"]) {
      assert.ok(names.has(required), `${required} missing`);
    }
    const created = await client.callTool({
      name: "task_upsert",
      arguments: { cwd, title: "MCP task", goal: "Prove stdio works", acceptance_criteria: ["MCP responds"], next_steps: ["call status"] }
    });
    assert.equal(created.isError, undefined);
    const status = await client.callTool({ name: "status", arguments: { cwd } });
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /MCP task/);
  } finally {
    await client.close();
  }
});

test("the packaged MCP launcher resolves PLUGIN_ROOT without shell interpolation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-memory-package-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-memory-package-data-"));
  const pluginRoot = resolve(".");
  const config = JSON.parse(readFileSync(resolve(".mcp.json"), "utf8")).mcpServers.project_memory;
  const client = new Client({ name: "project-memory-package-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: data }
  });
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "status", arguments: { cwd } });
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /project-memory.sqlite3/);
  } finally {
    await client.close();
  }
});

test("the unified plugin exposes the role-runtime MCP server from the same package", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-unified-role-project-"));
  const data = mkdtempSync(join(tmpdir(), "codex-unified-role-data-"));
  const pluginRoot = resolve(".");
  const config = JSON.parse(readFileSync(resolve(".mcp.json"), "utf8")).mcpServers.role_runtime;
  const client = new Client({ name: "unified-role-package-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, CODEX_ROLE_RUNTIME_HOME: data }
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((item) => item.name));
    for (const required of ["role_attach", "liaison_request", "liaison_result", "message_send"]) assert.ok(names.has(required), `${required} missing`);
    assert.equal(names.has("role_start"), false, "Role MCP must not expose hidden task startup");
    const initialized = await client.callTool({ name: "project_initialize", arguments: { cwd } });
    assert.equal(initialized.isError, undefined);
    const attached = await client.callTool({ name: "role_attach", arguments: { cwd, role_key: "coordinator", thread_id: "desktop-created-task" } });
    assert.equal(attached.isError, undefined);
    assert.match(attached.content[0].text, /desktop-created-task/);
    const status = await client.callTool({ name: "status", arguments: { cwd } });
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /role-runtime.sqlite3/);
    assert.match(status.content[0].text, /liaison/);
  } finally { await client.close(); }
});

test("CLI and MCP share the canonical Codex plugin-data directory by default", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-memory-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "codex-memory-default-project-"));
  const env = { ...process.env, CODEX_HOME: codexHome };
  delete env.CODEX_PROJECT_MEMORY_HOME; delete env.PLUGIN_DATA;
  const run = spawnSync(process.execPath, ["--no-warnings", resolve("dist/cli.mjs"), "status", "--cwd", cwd], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const status = JSON.parse(run.stdout);
  assert.equal(status.database_path, join(codexHome, "plugin-data", "codex-project-memory", "project-memory.sqlite3"));
});
