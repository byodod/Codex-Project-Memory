import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginParent = join(homedir(), "plugins");
const target = join(pluginParent, "codex-project-memory");
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const pluginData = join(codexHome, "plugin-data", "codex-project-memory");
const roleData = join(codexHome, "plugin-data", "codex-role-runtime");
const legacyRolePlugin = join(pluginParent, "codex-role-runtime");
const marketplacePath = join(homedir(), ".agents", "plugins", "marketplace.json");
const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const staging = join(pluginParent, `.codex-project-memory.stage-${process.pid}`);
const backup = join(pluginParent, `codex-project-memory.backup-${timestamp}`);

const build = spawnSync("npm", ["run", "build"], { cwd: source, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(pluginParent, { recursive: true });
await rm(staging, { recursive: true, force: true });
await cp(source, staging, {
  recursive: true,
  filter: (path) => !/(?:^|[\\/])(node_modules|src|tests|\.git)(?:[\\/]|$)/.test(path)
});
if (existsSync(target)) await rename(target, backup);
await rename(staging, target);

// Codex injects PLUGIN_ROOT into hook processes, but bundled MCP processes do
// not currently receive it. Materialize a stable absolute entry point in the
// personal plugin copy so the server starts from every project and worktree.
const installedMcp = {
  mcpServers: {
    project_memory: {
      command: "node",
      args: ["--no-warnings", join(target, "dist", "mcp-server.mjs")],
      env: { CODEX_PROJECT_MEMORY_HOME: pluginData }
    }
  }
};
await writeFile(join(target, ".mcp.json"), `${JSON.stringify(installedMcp, null, 2)}\n`, "utf8");

if (!existsSync(marketplacePath)) throw new Error(`Personal marketplace is missing: ${marketplacePath}`);
const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
const marketplaceEntry = marketplace.plugins?.find((item) => item.name === "codex-project-memory");
if (!marketplaceEntry) throw new Error("The personal marketplace does not contain codex-project-memory. Scaffold the marketplace entry before running the update installer.");
const removeLegacy = spawnSync("codex", ["plugin", "remove", `codex-role-runtime@${marketplace.name}`], { encoding: "utf8", shell: process.platform === "win32" });

const add = spawnSync("codex", ["plugin", "add", `codex-project-memory@${marketplace.name}`], {
  stdio: "inherit", shell: process.platform === "win32"
});
if (add.status !== 0) {
  process.stderr.write(`Plugin files and marketplace entry are ready, but Codex install returned ${add.status}. Run: codex plugin add codex-project-memory@${marketplace.name}\n`);
  process.exit(add.status ?? 1);
}

process.stdout.write(`Installed Codex Project Memory from ${target}\nMarketplace: ${marketplacePath}\n`);
await rm(roleData, { recursive: true, force: true });
await rm(legacyRolePlugin, { recursive: true, force: true });
process.stdout.write(`Removed legacy Role Runtime data from ${roleData}\n`);
if (removeLegacy.status === 0) process.stdout.write("Removed the standalone codex-role-runtime installation.\n");
if (existsSync(backup)) process.stdout.write(`Previous plugin copy preserved at ${backup}\n`);
process.stdout.write("Restart Codex, start a new task, and review/trust the plugin hooks with /hooks.\n");
