import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginParent = join(homedir(), "plugins");
const target = join(pluginParent, "codex-role-runtime");
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const pluginData = join(codexHome, "plugin-data", "codex-role-runtime");
const marketplacePath = join(homedir(), ".agents", "plugins", "marketplace.json");
const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const staging = join(pluginParent, `.codex-role-runtime.stage-${process.pid}`);
const backup = join(pluginParent, `codex-role-runtime.backup-${timestamp}`);

const build = spawnSync("npm", ["run", "build"], { cwd: source, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(pluginParent, { recursive: true });
await rm(staging, { recursive: true, force: true });
await cp(source, staging, { recursive: true, filter: (path) => !/(?:^|[\\/])(node_modules|src|tests|\.git)(?:[\\/]|$)/.test(path) });
if (existsSync(target)) await rename(target, backup);
await rename(staging, target);

const installedMcp = {
  mcpServers: {
    role_runtime: {
      command: "node",
      args: ["--no-warnings", join(target, "dist", "mcp-server.mjs")],
      env: { CODEX_ROLE_RUNTIME_HOME: pluginData }
    }
  }
};
await writeFile(join(target, ".mcp.json"), `${JSON.stringify(installedMcp, null, 2)}\n`, "utf8");

await mkdir(dirname(marketplacePath), { recursive: true });
let marketplace = { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
if (existsSync(marketplacePath)) marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
marketplace.interface ||= { displayName: "Personal" }; marketplace.plugins ||= [];
const entry = {
  name: "codex-role-runtime", source: { source: "local", path: "./plugins/codex-role-runtime" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools"
};
const index = marketplace.plugins.findIndex((item) => item.name === entry.name);
if (index >= 0) marketplace.plugins[index] = entry; else marketplace.plugins.push(entry);
const marketTemp = `${marketplacePath}.${process.pid}.tmp`;
await writeFile(marketTemp, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8"); await rename(marketTemp, marketplacePath);

const add = spawnSync("codex", ["plugin", "add", `codex-role-runtime@${marketplace.name}`], { stdio: "inherit", shell: process.platform === "win32" });
if (add.status !== 0) process.exit(add.status ?? 1);
process.stdout.write(`Installed Codex Role Runtime from ${target}\nMarketplace: ${marketplacePath}\nData: ${pluginData}\n`);
if (existsSync(backup)) process.stdout.write(`Previous plugin copy preserved at ${backup}\n`);
process.stdout.write("Restart Codex, start a new task, and review/trust the plugin hooks with /hooks.\n");
