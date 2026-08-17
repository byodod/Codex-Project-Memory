import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "skills/project-memory/SKILL.md",
  "skills/reset-project/SKILL.md",
  "skills/reset-project/agents/openai.yaml",
  "dist/mcp-server.mjs",
  "dist/hook.mjs",
  "dist/cli.mjs"
];

for (const relative of required) await access(resolve(root, relative));
const manifest = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
const hooks = JSON.parse(await readFile(resolve(root, "hooks/hooks.json"), "utf8"));
if (manifest.name !== "codex-project-memory" || manifest.mcpServers !== "./.mcp.json") throw new Error("Manifest identity or MCP path is invalid.");
const resetSkill = await readFile(resolve(root, "skills/reset-project/SKILL.md"), "utf8");
const resetSkillUi = await readFile(resolve(root, "skills/reset-project/agents/openai.yaml"), "utf8");
if (!resetSkill.includes("name: reset-project") || resetSkill.includes("[TODO:")) throw new Error("Reset Project slash-menu skill is invalid.");
if (!resetSkillUi.includes('display_name: "Reset Project Memory"') || !resetSkillUi.includes("allow_implicit_invocation: false")) {
  throw new Error("Reset Project skill must be visible in the UI and explicit-only.");
}
if (!mcp.mcpServers?.project_memory?.args?.some((value) => value.includes("process.env.PLUGIN_ROOT"))) throw new Error("MCP entry must resolve from the PLUGIN_ROOT environment.");
if (Object.keys(mcp.mcpServers ?? {}).join(",") !== "project_memory") throw new Error("Only the project_memory MCP server may be packaged.");
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop", "SessionEnd"]) {
  if (!hooks.hooks[event]?.length) throw new Error(`Missing ${event} hook.`);
}
const sessionEndHandlers = hooks.hooks.SessionEnd.flatMap((registration) => registration.hooks || []);
if (sessionEndHandlers.some((hook) => hook.timeout === undefined || hook.timeout > 3)) {
  throw new Error("SessionEnd Hook timeout must be explicitly set to at most 3 seconds.");
}
const contextLimits = {
  SessionStart: 6500,
  UserPromptSubmit: 4000,
  PreToolUse: 2600
};
for (const [event, maximum] of Object.entries(contextLimits)) {
  const handlers = hooks.hooks[event].flatMap((registration) => registration.hooks || []);
  if (handlers.some((hook) => hook.additionalContextLimit === undefined || hook.additionalContextLimit > maximum)) {
    throw new Error(`${event} additionalContextLimit must be explicitly set to at most ${maximum} characters.`);
  }
}
const commands = Object.values(hooks.hooks).flatMap((registrations) => registrations.flatMap((registration) => registration.hooks || []).map((hook) => hook.command));
if (!commands.every((command) => command?.includes("dist','hook.mjs"))) throw new Error("Every lifecycle event must use the Project Memory Hook launcher.");
if (commands.some((command) => !command?.includes("process.env.PLUGIN_ROOT"))) throw new Error("Hook launchers must resolve from PLUGIN_ROOT without shell interpolation.");
const files = await Promise.all(required.map(async (relative) => [relative, (await stat(resolve(root, relative))).size]));
process.stdout.write(`${JSON.stringify({ ok: true, manifest: manifest.version, files: Object.fromEntries(files) }, null, 2)}\n`);
