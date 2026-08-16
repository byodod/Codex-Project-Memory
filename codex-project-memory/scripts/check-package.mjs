import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "skills/project-memory/SKILL.md",
  "dist/mcp-server.mjs",
  "dist/hook.mjs",
  "dist/cli.mjs"
];

for (const relative of required) await access(resolve(root, relative));
const manifest = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
const hooks = JSON.parse(await readFile(resolve(root, "hooks/hooks.json"), "utf8"));
if (manifest.name !== "codex-project-memory" || manifest.mcpServers !== "./.mcp.json") throw new Error("Manifest identity or MCP path is invalid.");
if (!mcp.mcpServers?.project_memory?.args?.some((value) => value.includes("process.env.PLUGIN_ROOT"))) throw new Error("MCP entry must resolve from the PLUGIN_ROOT environment.");
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop", "SessionEnd"]) {
  if (!hooks.hooks[event]?.length) throw new Error(`Missing ${event} hook.`);
}
const files = await Promise.all(required.map(async (relative) => [relative, (await stat(resolve(root, relative))).size]));
process.stdout.write(`${JSON.stringify({ ok: true, manifest: manifest.version, files: Object.fromEntries(files) }, null, 2)}\n`);
