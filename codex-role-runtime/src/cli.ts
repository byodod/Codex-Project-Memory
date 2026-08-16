import { spawnSync } from "node:child_process";
import { AppServerClient, resolveCodexBinary } from "./app-server.js";
import { resolveProject } from "./project.js";
import { RoleStore } from "./store.js";
import { BootstrapResponse, RoleRecord } from "./types.js";

const raw = process.argv.slice(2);
function option(name: string): string | undefined { const at = raw.indexOf(name); return at >= 0 ? raw[at + 1] : undefined; }
function positional(): string[] { return raw.filter((value, index) => !value.startsWith("--") && (index === 0 || !raw[index - 1]?.startsWith("--"))); }
const args = positional(); const command = args[0] || "status"; const cwd = option("--cwd") || process.cwd();
const store = new RoleStore(); const project = resolveProject(cwd);

function expectedBootstrap(role: RoleRecord): BootstrapResponse {
  const context = store.context(project, role.role_key);
  const facts = context.facts as Array<Record<string, unknown>>;
  return {
    role_id: role.role_key, mission: role.mission, owned_domains: role.owned_domains,
    critical_invariants: facts.filter((fact) => fact.kind === "invariant").map((fact) => String(fact.content)),
    open_questions: facts.filter((fact) => fact.kind === "open_question").map((fact) => String(fact.content)),
    architecture_epoch: Number((context.project as Record<string, unknown>).architecture_epoch)
  };
}

async function rotate(roleKey: string, reason: string, model?: string): Promise<unknown> {
  const role = store.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
  const rotation = store.createRotation(project, roleKey, reason);
  const client = await AppServerClient.connect();
  try {
    store.updateRotation(String(rotation.id), "DRAINING");
    store.updateRotation(String(rotation.id), "CHECKPOINTING");
    store.updateRotation(String(rotation.id), "VALIDATING");
    const threadId = await client.startThread({ cwd: project.root, ...(model ? { model } : {}), policy: role.policy, name: `${role.name} · Generation` });
    const expected = expectedBootstrap(role);
    const candidate = store.createCandidate(project, roleKey, threadId, JSON.stringify(expected));
    store.updateRotation(String(rotation.id), "BOOTSTRAPPING", { candidateId: candidate.id });
    await client.setGoal(threadId, `Act as ${role.name}: ${role.mission}`);
    const actual = raw.includes("--deterministic-bootstrap") ? expected : await client.bootstrapHealth(threadId, expected, store.roleAnchor(project, roleKey));
    const validation = store.validateBootstrap(project, roleKey, actual);
    if (!validation.ok) {
      store.rejectCandidate(candidate.id, validation.errors.join("; "));
      store.updateRotation(String(rotation.id), "FAILED", { error: validation.errors.join("; ") });
      throw new Error(`Bootstrap rejected: ${validation.errors.join("; ")}`);
    }
    store.updateRotation(String(rotation.id), "CUTOVER");
    const active = store.activateCandidate(project, roleKey, candidate.id, reason);
    store.updateRotation(String(rotation.id), "COMPLETED");
    return { rotation_id: rotation.id, role: roleKey, generation: active, validation };
  } catch (error) {
    try { store.updateRotation(String(rotation.id), "FAILED", { error: error instanceof Error ? error.message : String(error) }); } catch { /* retain original error */ }
    throw error;
  } finally { client.close(); }
}

try {
  let output: unknown;
  switch (command) {
    case "init":
      store.configureProject(project, option("--constitution") || "Preserve modular boundaries, route cross-domain decisions through semantic owners, and require independent verification.");
      output = [
        store.defineRole(project, { role_key: "coordinator", name: "Coordinator", kind: "governance", mission: "Maintain project goal, task graph, dependencies, role directory, blockers, and routing without absorbing all module knowledge.", owned_domains: ["project goal", "task graph", "routing", "milestones"], excluded_domains: ["implementation", "module internals"], escalation_rules: ["Architecture changes go to role://architect"], policy: { mode: "read_only", canDelegateTo: ["architect", "verifier"] } }),
        store.defineRole(project, { role_key: "architect", name: "Architect", kind: "governance", mission: "Protect system structure, semantic ownership, dependency direction, cross-module contracts, and migrations.", owned_domains: ["architecture", "module boundaries", "dependency direction", "cross-module contracts"], excluded_domains: ["routine implementation"], escalation_rules: ["User decides product-direction changes"], policy: { mode: "read_only", canDelegateTo: ["verifier"] } }),
        store.defineRole(project, { role_key: "verifier", name: "Verifier", kind: "governance", mission: "Independently verify requirements, architecture consistency, actual diff scope, and objective test evidence.", owned_domains: ["verification", "acceptance", "diff review"], excluded_domains: ["implementation"], escalation_rules: ["Reject unverifiable or out-of-scope changes"], policy: { mode: "read_only", freshVerification: true } })
      ];
      break;
    case "status": output = store.status(project); break;
    case "doctor": {
      const version = spawnSync("codex", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
      output = { ok: version.status === 0, node: process.version, codex: version.stdout.trim(), database: store.databasePath, project: project.root };
      break;
    }
    case "bind": output = store.bindInitial(project, args[1] || "", args[2] || ""); break;
    case "context": output = store.context(project, args[1] || ""); break;
    case "rotate": output = await rotate(args[1] || "", option("--reason") || "manual rotation", option("--model")); break;
    case "start":
      if (store.activeGeneration(project, args[1] || "")) throw new Error("Role already has an active generation; use rotate.");
      output = await rotate(args[1] || "", option("--reason") || "initial generation", option("--model"));
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
