import { MemoryStore } from "./storage.js";
import { resolveProject } from "./repository.js";

const [command = "status", ...rest] = process.argv.slice(2);
const cwdFlag = rest.indexOf("--cwd");
const cwd = cwdFlag >= 0 ? rest[cwdFlag + 1] : process.cwd();
const args = rest.filter((_, index) => index !== cwdFlag && index !== cwdFlag + 1);
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
      output = store.consolidate(project, args.includes("--apply"));
      break;
    default:
      throw new Error("Usage: cli.mjs [doctor|status|task [id]|search <query>|checkpoint|consolidate [--apply]] [--cwd <path>]");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
