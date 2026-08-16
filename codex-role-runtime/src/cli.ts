import { attachRoleThread } from "./generation-service.js";
import { resolveProject } from "./project.js";
import { RoleStore } from "./store.js";
import { initializeStandardTopology } from "./topology.js";

const raw = process.argv.slice(2);
function option(name: string): string | undefined { const at = raw.indexOf(name); return at >= 0 ? raw[at + 1] : undefined; }
function positional(): string[] { return raw.filter((value, index) => !value.startsWith("--") && (index === 0 || !raw[index - 1]?.startsWith("--"))); }
const args = positional(); const command = args[0] || "status"; const cwd = option("--cwd") || process.cwd();
const store = new RoleStore(); const project = resolveProject(cwd);

try {
  let output: unknown;
  switch (command) {
    case "init":
      output = initializeStandardTopology(store, project, option("--constitution"));
      break;
    case "status": output = store.status(project); break;
    case "doctor": {
      output = { ok: true, node: process.version, database: store.databasePath, project: project.root, task_transport: "Codex desktop tools (LLM-managed)" };
      break;
    }
    case "bind": output = store.bindInitial(project, args[1] || "", args[2] || ""); break;
    case "attach": output = attachRoleThread(store, project, args[1] || "", args[2] || "", option("--reason")); break;
    case "context": output = store.context(project, args[1] || ""); break;
    default: throw new Error("Usage: codex-role [init|status|doctor|bind <role> <thread>|attach <role> <thread> --reason <text>|context <role>] [--cwd <path>]");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
} finally { store.close(); }
