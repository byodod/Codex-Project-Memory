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
    for (const required of ["mainline_get", "plan_get", "plan_upsert", "task_get", "task_upsert", "memory_search", "memory_store", "verification_record", "task_checkpoint"]) {
      assert.ok(names.has(required), `${required} missing`);
    }
    const plan = await client.callTool({
      name: "plan_upsert",
      arguments: { cwd, project_goal: "Prove the mainline survives", definition_of_done: ["MCP responds"], current_milestone: "stdio" }
    });
    assert.equal(plan.isError, undefined);
    const planId = plan.structuredContent.result.id;
    const created = await client.callTool({
      name: "task_upsert",
      arguments: { cwd, plan_id: planId, title: "MCP task", goal: "Prove stdio works", acceptance_criteria: ["MCP responds"], exact_next_action: "call status" }
    });
    assert.equal(created.isError, undefined);
    const status = await client.callTool({ name: "status", arguments: { cwd } });
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /MCP task/);
    const mainline = await client.callTool({ name: "mainline_get", arguments: { cwd } });
    assert.equal(mainline.isError, undefined);
    assert.match(mainline.content[0].text, /call status/);
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
