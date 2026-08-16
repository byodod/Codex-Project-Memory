import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  ".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json", "skills/role-runtime/SKILL.md", "LICENSE", "README.md",
  "dist/mcp-server.mjs", "dist/hook.mjs", "dist/cli.mjs", "dist/library.mjs"
];
for (const relative of required) await access(resolve(root, relative));
const manifest = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
const hooks = JSON.parse(await readFile(resolve(root, "hooks/hooks.json"), "utf8"));
if (manifest.name !== "codex-role-runtime" || manifest.mcpServers !== "./.mcp.json") throw new Error("Invalid plugin identity or MCP path.");
if (!mcp.mcpServers?.role_runtime?.args?.some((value) => value.includes("process.env.PLUGIN_ROOT"))) throw new Error("MCP entry must resolve from PLUGIN_ROOT.");
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop", "SessionEnd"])
  if (!hooks.hooks[event]?.length) throw new Error(`Missing ${event} hook.`);
for (const registrations of Object.values(hooks.hooks)) for (const registration of registrations)
  for (const hook of registration.hooks || []) if (!hook.command?.includes("process.env.PLUGIN_ROOT")) throw new Error("Hook command must resolve from the PLUGIN_ROOT environment without shell interpolation.");
const files = await Promise.all(required.map(async (relative) => [relative, (await stat(resolve(root, relative))).size]));
process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.version, files: Object.fromEntries(files) }, null, 2)}\n`);
