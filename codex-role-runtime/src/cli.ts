import { spawnSync } from "node:child_process";
import { resolveCodexBinary } from "./app-server.js";
import { rotateRoleGeneration } from "./generation-service.js";
import { resolveProject } from "./project.js";
import { RoleStore } from "./store.js";
import { initializeStandardTopology } from "./topology.js";

const raw = process.argv.slice(2);
function option(name: string): string | undefined { const at = raw.indexOf(name); return at >= 0 ? raw[at + 1] : undefined; }
function positional(): string[] { return raw.filter((value, index) => !value.startsWith("--") && (index === 0 || !raw[index - 1]?.startsWith("--"))); }
const args = positional(); const command = args[0] || "status"; const cwd = option("--cwd") || process.cwd();
const store = new RoleStore(); const project = resolveProject(cwd);

function generationOptions(): { model?: string; deterministicBootstrap: boolean } {
  const model = option("--model");
  return { ...(model ? { model } : {}), deterministicBootstrap: raw.includes("--deterministic-bootstrap") };
}

try {
  let output: unknown;
  switch (command) {
    case "init":
      output = initializeStandardTopology(store, project, option("--constitution"));
      break;
    case "status": output = store.status(project); break;
    case "doctor": {
      const version = spawnSync("codex", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
      output = { ok: version.status === 0, node: process.version, codex: version.stdout.trim(), database: store.databasePath, project: project.root };
      break;
    }
    case "bind": output = store.bindInitial(project, args[1] || "", args[2] || ""); break;
    case "context": output = store.context(project, args[1] || ""); break;
    case "rotate": output = await rotateRoleGeneration(store, project, args[1] || "", option("--reason") || "manual rotation", generationOptions()); break;
    case "start":
      if (store.activeGeneration(project, args[1] || "")) throw new Error("Role already has an active generation; use rotate.");
      output = await rotateRoleGeneration(store, project, args[1] || "", option("--reason") || "initial generation", generationOptions());
      break;
    case "open": case "continue": {
      const active = store.activeGeneration(project, args[1] || ""); if (!active) throw new Error("Role has no active generation.");
      store.close();
      const codex = resolveCodexBinary();
      let resumed;
      if (process.platform === "win32" && !codex.toLowerCase().endsWith(".exe")) {
        if (!/^[A-Za-z0-9_-]+$/.test(active.thread_id)) throw new Error("Unsafe thread id in role database.");
        const commandLine = `"${codex.replaceAll('"', '')}" resume ${active.thread_id} -C "%CODEX_ROLE_OPEN_CWD%"`;
        resumed = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
          stdio: "inherit", shell: false, env: { ...process.env, CODEX_ROLE_OPEN_CWD: project.root }
        });
      } else resumed = spawnSync(codex, ["resume", active.thread_id, "-C", project.root], { stdio: "inherit", shell: false });
      process.exit(resumed.status ?? 1);
    }
    default: throw new Error("Usage: codex-role [init|status|doctor|bind <role> <thread>|context <role>|start <role>|rotate <role> --reason <text>|open <role>] [--cwd <path>] [--model <slug>]");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
} finally { try { store.close(); } catch { /* already closed before interactive resume */ } }
