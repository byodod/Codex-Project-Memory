import { MemoryStore } from "./storage.js";
import { resolveProject } from "./repository.js";
import { RoleStore } from "../../codex-role-runtime/src/store.js";
import { resolveProject as resolveRoleProject } from "../../codex-role-runtime/src/project.js";
import { resolve } from "node:path";

const [command = "status", ...rest] = process.argv.slice(2);
function option(name: string): string | undefined { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; }
function positional(): string[] { return rest.filter((value, index) => !value.startsWith("--") && (index === 0 || !rest[index - 1]?.startsWith("--"))); }
const cwd = option("--cwd") || process.cwd();
const args = positional();
const store = new MemoryStore();
const project = resolveProject(cwd);

try {
  let output: unknown;
  switch (command) {
    case "doctor":
      output = { ok: true, node: process.version, ...store.status(project), fts5: true };
      break;
    case "status":
      output = store.status(project);
      break;
    case "task":
      output = store.getTask(project, args[0]);
      break;
    case "search":
      output = store.search(project, args.join(" "), { limit: 10 });
      break;
    case "checkpoint":
      output = store.checkpoint(project, { trigger: "cli" });
      break;
    case "consolidate":
      output = store.consolidate(project, rest.includes("--apply"));
      break;
    case "reset-project": {
      const confirmedRoot = option("--confirm-root");
      const canonicalRoot = resolve(project.root);
      if (!confirmedRoot || resolve(confirmedRoot).toLowerCase() !== canonicalRoot.toLowerCase()) {
        throw new Error(`RESET_CONFIRMATION_REQUIRED: rerun with --confirm-root "${project.root}"`);
      }
      const roleStore = new RoleStore();
      try {
        const roleProject = resolveRoleProject(cwd);
        output = {
          ok: true,
          root: project.root,
          role_runtime: roleStore.resetProject(roleProject),
          project_memory: store.resetProject(project),
          next: "Start a new Codex task and send 初始化角色编排 to rebuild from zero."
        };
      } finally { roleStore.close(); }
      break;
    }
    default:
      throw new Error("Usage: cli.mjs [doctor|status|task [id]|search <query>|checkpoint|consolidate [--apply]|reset-project --confirm-root <exact-project-root>] [--cwd <path>]");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
