// ../codex-role-runtime/src/cli.ts
import { spawnSync } from "node:child_process";

// ../codex-role-runtime/src/app-server.ts
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
function resolveCodexBinary() {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }
  if (process.platform === "win32") {
    try {
      const candidates = execFileSync("where.exe", ["codex.cmd"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (candidates[0]) return candidates[0];
    } catch {
    }
  }
  return "codex";
}
var AppServerClient = class _AppServerClient {
  child;
  lines;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  stderr = [];
  constructor(command2 = resolveCodexBinary()) {
    this.child = spawn(command2, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && !command2.toLowerCase().endsWith(".exe")
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr.push(chunk);
      if (this.stderr.length > 50) this.stderr.shift();
    });
    this.child.on("exit", (code) => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Codex app-server exited with ${code}. ${this.stderr.join("").slice(-2e3)}`));
      }
      this.pending.clear();
    });
  }
  static async connect() {
    const client = new _AppServerClient();
    await client.request("initialize", { clientInfo: { name: "codex-role-runtime", title: "Codex Role Runtime", version: "1.0.0" } });
    client.notify("initialized", {});
    return client;
  }
  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number" && (message.result !== void 0 || message.error !== void 0)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`App Server RPC error: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }
  request(method, params, timeoutMs = 3e4) {
    const id = this.nextId++;
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve2, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}
`);
    });
  }
  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}
`);
  }
  async startThread(input) {
    const params = {
      cwd: input.cwd,
      approvalPolicy: "never",
      sandbox: input.policy.mode === "read_only" ? "read-only" : "workspace-write",
      serviceName: "codex-role-runtime"
    };
    if (input.model) params.model = input.model;
    const result = await this.request("thread/start", params, 6e4);
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(result)}`);
    await this.request("thread/name/set", { threadId, name: input.name }).catch(() => void 0);
    return threadId;
  }
  async resumeThread(threadId) {
    const result = await this.request("thread/resume", { threadId }, 6e4);
    if (result?.thread?.id !== threadId) throw new Error(`thread/resume returned the wrong thread: ${JSON.stringify(result)}`);
  }
  async runTurn(threadId, prompt, timeoutMs = 9e5) {
    await this.resumeThread(threadId);
    let lastText = "";
    const completed = new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("Role dispatch turn timed out."));
      }, timeoutMs);
      const listener = (message) => {
        const params = message.params || {};
        if (params.threadId && params.threadId !== threadId) return;
        if (message.method === "item/agentMessage/delta") lastText += params.delta || "";
        if (message.method === "item/completed" && params.item?.type === "agentMessage") lastText = params.item.text || lastText;
        if (message.method === "turn/completed") {
          clearTimeout(timer);
          this.listeners.delete(listener);
          if (params.turn?.status && !["completed", "Completed"].includes(params.turn.status)) reject(new Error(`Role dispatch turn ${params.turn.status}`));
          else resolve2();
        }
      };
      this.listeners.add(listener);
    });
    await this.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] }, 6e4);
    await completed;
    return lastText.trim();
  }
  close() {
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
  }
};

// ../codex-role-runtime/src/generation-service.ts
function expectedBootstrap(store2, project2, role) {
  const context = store2.context(project2, role.role_key);
  const facts = context.facts;
  return {
    role_id: role.role_key,
    mission: role.mission,
    owned_domains: role.owned_domains,
    critical_invariants: facts.filter((fact) => fact.kind === "invariant").map((fact) => String(fact.content)),
    open_questions: facts.filter((fact) => fact.kind === "open_question").map((fact) => String(fact.content)),
    architecture_epoch: Number(context.project.architecture_epoch)
  };
}
async function rotateRoleGeneration(store2, project2, roleKey, reason, options = {}) {
  const role = store2.getRole(project2, roleKey);
  if (!role) throw new Error(`Unknown role: ${roleKey}`);
  const rotation = store2.createRotation(project2, roleKey, reason);
  let client = null;
  let candidate = null;
  try {
    client = options.clientFactory ? await options.clientFactory() : await AppServerClient.connect();
    store2.updateRotation(String(rotation.id), "DRAINING");
    store2.updateRotation(String(rotation.id), "CHECKPOINTING");
    store2.updateRotation(String(rotation.id), "VALIDATING");
    const threadId = await client.startThread({ cwd: project2.root, ...options.model ? { model: options.model } : {}, policy: role.policy, name: `${role.name} \xB7 Generation` });
    const expected = expectedBootstrap(store2, project2, role);
    candidate = store2.createCandidate(project2, roleKey, threadId, JSON.stringify(expected));
    store2.updateRotation(String(rotation.id), "BOOTSTRAPPING", { candidateId: candidate.id });
    const validation = store2.validateBootstrap(project2, roleKey, expected);
    if (!validation.ok) {
      store2.rejectCandidate(candidate.id, validation.errors.join("; "));
      store2.updateRotation(String(rotation.id), "FAILED", { error: validation.errors.join("; ") });
      throw new Error(`Bootstrap rejected: ${validation.errors.join("; ")}`);
    }
    store2.updateRotation(String(rotation.id), "CUTOVER");
    const active = store2.activateCandidate(project2, roleKey, candidate.id, reason);
    store2.updateRotation(String(rotation.id), "COMPLETED");
    return { rotation_id: rotation.id, role: roleKey, generation: active, validation };
  } catch (error) {
    if (candidate) {
      try {
        store2.rejectCandidate(candidate.id, `Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
      }
    }
    try {
      store2.updateRotation(String(rotation.id), "FAILED", { error: error instanceof Error ? error.message : String(error) });
    } catch {
    }
    throw error;
  } finally {
    client?.close();
  }
}
async function startRoleGeneration(store2, project2, roleKey, options = {}) {
  const active = store2.activeGeneration(project2, roleKey);
  if (active) return { role: roleKey, status: "active", started: false, generation: active };
  const candidate = store2.bootstrappingGeneration(project2, roleKey);
  const rotation = store2.openRotation(project2, roleKey);
  if (candidate && rotation) return { role: roleKey, status: "bootstrapping", started: false, generation: candidate, rotation_id: rotation.id };
  if (candidate) store2.rejectCandidate(candidate.id, "Recovered orphaned bootstrap candidate before retrying role_start.");
  if (rotation) return { role: roleKey, status: "starting", started: false, rotation_id: rotation.id };
  const result = await rotateRoleGeneration(store2, project2, roleKey, "initial generation", options);
  return { ...result, status: "active", started: true };
}

// ../codex-role-runtime/src/project.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// ../codex-role-runtime/src/util.ts
import { createHash, randomUUID } from "node:crypto";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}
function stableId(value, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
function stableHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function compactText(value, max) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}
function uniqueStrings(values, max = 100) {
  return [...new Set((values ?? []).map((value) => compactText(value, 1e3)).filter(Boolean))].slice(0, max);
}
function parseJson(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function slug(value) {
  const result = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result || result.length > 64) throw new Error("Role key must normalize to 1-64 ASCII characters.");
  return result;
}
function matchesAny(value, patterns) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return value === pattern;
    }
  });
}

// ../codex-role-runtime/src/project.ts
function git(cwd2, args2) {
  try {
    return execFileSync2("git", args2, { cwd: cwd2, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function resolveProject(input = process.cwd()) {
  let current = resolve(input);
  if (!existsSync(current)) throw new Error(`Working directory does not exist: ${current}`);
  current = realpathSync(current);
  const root = git(current, ["rev-parse", "--show-toplevel"]) ?? current;
  const commonRaw = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitCommonDir = commonRaw ? resolve(root, commonRaw) : null;
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const identity = gitCommonDir || remote || root.toLowerCase();
  return {
    id: stableId(identity),
    root,
    name: basename(root) || basename(dirname(root)),
    remote,
    gitCommonDir,
    branch: git(root, ["branch", "--show-current"]),
    revision: git(root, ["rev-parse", "HEAD"])
  };
}

// ../codex-role-runtime/src/store.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_POLICY = {
  mode: "read_only",
  deniedTools: ["apply_patch", "Edit", "Write"],
  allowedWriteGlobs: [],
  canDelegateTo: [],
  freshVerification: false
};
function roleFromRow(row) {
  return {
    ...row,
    kind: row.kind,
    owned_domains: parseJson(row.owned_domains, []),
    excluded_domains: parseJson(row.excluded_domains, []),
    escalation_rules: parseJson(row.escalation_rules, []),
    policy: parseJson(row.policy, DEFAULT_POLICY)
  };
}
function generationFromRow(row) {
  return {
    ...row,
    generation_number: Number(row.generation_number),
    architecture_epoch: Number(row.architecture_epoch),
    turn_count: Number(row.turn_count),
    compact_count: Number(row.compact_count),
    token_usage: Number(row.token_usage)
  };
}
var RoleStore = class {
  root;
  databasePath;
  db;
  constructor(root) {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    this.root = root || process.env.CODEX_ROLE_RUNTIME_HOME || process.env.PLUGIN_DATA || join(codexHome, "plugin-data", "codex-role-runtime");
    mkdirSync(this.root, { recursive: true });
    this.databasePath = join(this.root, "role-runtime.sqlite3");
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }
  close() {
    this.db.close();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, remote TEXT, git_common_dir TEXT,
        constitution TEXT NOT NULL DEFAULT '', architecture_epoch INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_common ON projects(git_common_dir) WHERE git_common_dir IS NOT NULL;

      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role_key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('governance','owner','worker')),
        mission TEXT NOT NULL, owned_domains TEXT NOT NULL DEFAULT '[]', excluded_domains TEXT NOT NULL DEFAULT '[]',
        escalation_rules TEXT NOT NULL DEFAULT '[]', policy TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, role_key)
      );

      CREATE TABLE IF NOT EXISTS role_generations (
        id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        generation_number INTEGER NOT NULL CHECK(generation_number > 0), thread_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('bootstrapping','active','retired','rejected')),
        health TEXT NOT NULL CHECK(health IN ('healthy','aging','rotation_required','retired','rejected')),
        architecture_epoch INTEGER NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0, token_usage INTEGER NOT NULL DEFAULT 0,
        bootstrap_hash TEXT, retirement_reason TEXT, started_at TEXT NOT NULL, ended_at TEXT, last_seen_at TEXT,
        UNIQUE(role_id, generation_number)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_generation ON role_generations(role_id) WHERE status='active';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_bootstrap_generation ON role_generations(role_id) WHERE status='bootstrapping';
      CREATE TRIGGER IF NOT EXISTS immutable_generation_binding
      BEFORE UPDATE OF role_id, thread_id, generation_number ON role_generations
      BEGIN SELECT RAISE(ABORT, 'THREAD_BINDING_IMMUTABLE'); END;

      CREATE TABLE IF NOT EXISTS role_leases (
        role_id TEXT PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
        generation_id TEXT NOT NULL REFERENCES role_generations(id) ON DELETE CASCADE,
        lease_epoch INTEGER NOT NULL, owner TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS role_facts (
        id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        fact_key TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
        authority TEXT NOT NULL CHECK(authority IN ('user_decision','project_authority','agent_inference','tool_observation')),
        source TEXT, architecture_epoch INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_role_facts_active ON role_facts(role_id, status, kind, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_role_fact ON role_facts(role_id, fact_key) WHERE status='active';

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','active','blocked','verifying','completed','cancelled')),
        scope TEXT NOT NULL DEFAULT '', acceptance_criteria TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL DEFAULT '{}',
        architecture_epoch INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY(task_id, depends_on), CHECK(task_id <> depends_on)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL, from_role_id TEXT NOT NULL REFERENCES roles(id), to_role_id TEXT NOT NULL REFERENCES roles(id),
        from_generation INTEGER NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        scope TEXT NOT NULL DEFAULT '', architecture_epoch INTEGER NOT NULL, payload TEXT NOT NULL,
        evidence_refs TEXT NOT NULL DEFAULT '[]', reply_to TEXT REFERENCES messages(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','acknowledged','rejected')),
        wake_status TEXT NOT NULL DEFAULT 'idle' CHECK(wake_status IN ('idle','running','completed','failed')),
        wake_error TEXT, wake_started_at TEXT, wake_completed_at TEXT,
        created_at TEXT NOT NULL, delivered_at TEXT, acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox ON messages(to_role_id, status, created_at);

      CREATE TABLE IF NOT EXISTS change_envelopes (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        owner_role_id TEXT NOT NULL REFERENCES roles(id), architecture_epoch INTEGER NOT NULL,
        intent TEXT NOT NULL, allowed_scope TEXT NOT NULL, expected_symbols TEXT NOT NULL DEFAULT '[]',
        constraints TEXT NOT NULL DEFAULT '[]', non_goals TEXT NOT NULL DEFAULT '[]', tests TEXT NOT NULL DEFAULT '[]',
        actual_paths TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','passed','violated','closed')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rotations (
        id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        old_generation_id TEXT REFERENCES role_generations(id), candidate_generation_id TEXT REFERENCES role_generations(id),
        state TEXT NOT NULL, reason TEXT NOT NULL, checkpoint TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rotation_open ON rotations(role_id) WHERE state NOT IN ('COMPLETED','FAILED');

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role_id TEXT REFERENCES roles(id), generation_id TEXT REFERENCES role_generations(id),
        event_key TEXT UNIQUE, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
      );
    `);
    this.migrateLegacyRoleFacts();
    this.migrateMessageWakeState();
  }
  migrateMessageWakeState() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map((row) => String(row.name)));
    if (!columns.has("wake_status")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_status TEXT NOT NULL DEFAULT 'idle' CHECK(wake_status IN ('idle','running','completed','failed'))");
    if (!columns.has("wake_error")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_error TEXT");
    if (!columns.has("wake_started_at")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_started_at TEXT");
    if (!columns.has("wake_completed_at")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_completed_at TEXT");
  }
  migrateLegacyRoleFacts() {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='role_facts'").get();
    if (!String(row?.sql || "").includes("UNIQUE(role_id, fact_key, status)")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        ALTER TABLE role_facts RENAME TO role_facts_legacy;
        CREATE TABLE role_facts (
          id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          fact_key TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
          authority TEXT NOT NULL CHECK(authority IN ('user_decision','project_authority','agent_inference','tool_observation')),
          source TEXT, architecture_epoch INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO role_facts SELECT * FROM role_facts_legacy;
        DROP TABLE role_facts_legacy;
        CREATE INDEX idx_role_facts_active ON role_facts(role_id, status, kind, updated_at DESC);
        CREATE UNIQUE INDEX idx_one_active_role_fact ON role_facts(role_id, fact_key) WHERE status='active';
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  ensureProject(project2) {
    const time = nowIso();
    this.db.prepare(`INSERT INTO projects(id,root,name,remote,git_common_dir,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,name=excluded.name,remote=excluded.remote,
      git_common_dir=excluded.git_common_dir,updated_at=excluded.updated_at`).run(project2.id, project2.root, project2.name, project2.remote, project2.gitCommonDir, time, time);
    return this.db.prepare("SELECT * FROM projects WHERE id=?").get(project2.id);
  }
  configureProject(project2, constitution) {
    this.ensureProject(project2);
    if (constitution !== void 0) this.db.prepare("UPDATE projects SET constitution=?,updated_at=? WHERE id=?").run(compactText(constitution, 12e3), nowIso(), project2.id);
    return this.db.prepare("SELECT * FROM projects WHERE id=?").get(project2.id);
  }
  projectEpoch(project2) {
    return Number(this.ensureProject(project2).architecture_epoch);
  }
  defineRole(project2, input) {
    this.ensureProject(project2);
    const key = slug(input.role_key);
    const existing = this.db.prepare("SELECT * FROM roles WHERE project_id=? AND role_key=?").get(project2.id, key);
    const policy = {
      ...DEFAULT_POLICY,
      ...existing ? parseJson(existing.policy, DEFAULT_POLICY) : {},
      ...input.policy,
      deniedTools: uniqueStrings(input.policy?.deniedTools ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).deniedTools : DEFAULT_POLICY.deniedTools)),
      allowedWriteGlobs: uniqueStrings(input.policy?.allowedWriteGlobs ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).allowedWriteGlobs : [])),
      canDelegateTo: uniqueStrings(input.policy?.canDelegateTo ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).canDelegateTo : []))
    };
    if (policy.mode === "workspace_write") policy.deniedTools = policy.deniedTools.filter((tool) => !["apply_patch", "Edit", "Write"].includes(tool));
    const time = nowIso();
    const id = existing ? String(existing.id) : newId("role");
    this.db.prepare(`INSERT INTO roles(id,project_id,role_key,name,kind,mission,owned_domains,excluded_domains,escalation_rules,policy,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,role_key) DO UPDATE SET name=excluded.name,kind=excluded.kind,
      mission=excluded.mission,owned_domains=excluded.owned_domains,excluded_domains=excluded.excluded_domains,
      escalation_rules=excluded.escalation_rules,policy=excluded.policy,updated_at=excluded.updated_at`).run(
      id,
      project2.id,
      key,
      compactText(input.name || key, 200),
      input.kind || "owner",
      compactText(input.mission, 4e3),
      JSON.stringify(uniqueStrings(input.owned_domains)),
      JSON.stringify(uniqueStrings(input.excluded_domains)),
      JSON.stringify(uniqueStrings(input.escalation_rules)),
      JSON.stringify(policy),
      existing ? String(existing.created_at) : time,
      time
    );
    return this.getRole(project2, key);
  }
  getRole(project2, roleKey) {
    this.ensureProject(project2);
    const row = this.db.prepare("SELECT * FROM roles WHERE project_id=? AND role_key=?").get(project2.id, slug(roleKey));
    return row ? roleFromRow(row) : null;
  }
  listRoles(project2) {
    this.ensureProject(project2);
    const rows = this.db.prepare("SELECT * FROM roles WHERE project_id=? ORDER BY kind,role_key").all(project2.id);
    return rows.map((row) => {
      const role = roleFromRow(row);
      const active = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id);
      const count = this.db.prepare("SELECT count(*) count FROM messages WHERE to_role_id=? AND status='pending'").get(role.id);
      return { ...role, active_generation: active ? generationFromRow(active) : null, pending_messages: Number(count.count) };
    });
  }
  getGenerationByThread(project2, threadId) {
    this.ensureProject(project2);
    const row = this.db.prepare(`SELECT g.*,r.project_id role_project_id,r.role_key,r.name role_name,r.kind role_kind,
      r.mission,r.owned_domains,r.excluded_domains,r.escalation_rules,r.policy,r.created_at role_created_at,r.updated_at role_updated_at
      FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE g.thread_id=? AND r.project_id=?`).get(threadId, project2.id);
    if (!row) return null;
    const role = roleFromRow({
      id: row.role_id,
      project_id: row.role_project_id,
      role_key: row.role_key,
      name: row.role_name,
      kind: row.role_kind,
      mission: row.mission,
      owned_domains: row.owned_domains,
      excluded_domains: row.excluded_domains,
      escalation_rules: row.escalation_rules,
      policy: row.policy,
      created_at: row.role_created_at,
      updated_at: row.role_updated_at
    });
    return { role, generation: generationFromRow(row) };
  }
  activeGeneration(project2, roleKey) {
    const role = this.getRole(project2, roleKey);
    if (!role) return null;
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id);
    return row ? generationFromRow(row) : null;
  }
  bootstrappingGeneration(project2, roleKey) {
    const role = this.getRole(project2, roleKey);
    if (!role) return null;
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='bootstrapping'").get(role.id);
    return row ? generationFromRow(row) : null;
  }
  openRotation(project2, roleKey) {
    const role = this.getRole(project2, roleKey);
    if (!role) return null;
    const row = this.db.prepare("SELECT * FROM rotations WHERE role_id=? AND state NOT IN ('COMPLETED','FAILED') ORDER BY created_at DESC LIMIT 1").get(role.id);
    return row || null;
  }
  bindInitial(project2, roleKey, threadId) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const existingThread = this.db.prepare("SELECT * FROM role_generations WHERE thread_id=?").get(threadId);
    if (existingThread) {
      if (existingThread.role_id !== role.id) throw new Error("THREAD_ALREADY_BOUND_TO_ANOTHER_ROLE");
      return generationFromRow(existingThread);
    }
    if (this.activeGeneration(project2, roleKey)) throw new Error("ROLE_ALREADY_HAS_ACTIVE_GENERATION");
    const time = nowIso();
    const id = newId("gen");
    const epoch = this.projectEpoch(project2);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO role_generations(id,role_id,generation_number,thread_id,status,health,architecture_epoch,started_at,last_seen_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, role.id, 1, threadId, "active", "healthy", epoch, time, time);
      this.db.prepare("INSERT INTO role_leases(role_id,generation_id,lease_epoch,owner,updated_at) VALUES(?,?,?,?,?)").run(role.id, id, 1, threadId, time);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.activeGeneration(project2, roleKey);
  }
  createCandidate(project2, roleKey, threadId, bootstrapHash) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const max = this.db.prepare("SELECT coalesce(max(generation_number),0) n FROM role_generations WHERE role_id=?").get(role.id);
    const number = Number(max.n) + 1;
    const time = nowIso();
    const id = newId("gen");
    this.db.prepare(`INSERT INTO role_generations(id,role_id,generation_number,thread_id,status,health,architecture_epoch,bootstrap_hash,started_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, role.id, number, threadId, "bootstrapping", "healthy", this.projectEpoch(project2), bootstrapHash || null, time, time);
    return generationFromRow(this.db.prepare("SELECT * FROM role_generations WHERE id=?").get(id));
  }
  activateCandidate(project2, roleKey, candidateId, reason) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const candidate = this.db.prepare("SELECT * FROM role_generations WHERE id=? AND role_id=?").get(candidateId, role.id);
    if (!candidate || candidate.status !== "bootstrapping") throw new Error("CANDIDATE_NOT_BOOTSTRAPPING");
    const time = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE role_generations SET status='retired',health='retired',retirement_reason=?,ended_at=? WHERE role_id=? AND status='active'").run(compactText(reason, 1e3), time, role.id);
      this.db.prepare("UPDATE role_generations SET status='active',health='healthy',last_seen_at=? WHERE id=?").run(time, candidateId);
      const lease = this.db.prepare("SELECT lease_epoch FROM role_leases WHERE role_id=?").get(role.id);
      this.db.prepare(`INSERT INTO role_leases(role_id,generation_id,lease_epoch,owner,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(role_id) DO UPDATE SET generation_id=excluded.generation_id,lease_epoch=excluded.lease_epoch,owner=excluded.owner,updated_at=excluded.updated_at`).run(role.id, candidateId, Number(lease?.lease_epoch || 0) + 1, String(candidate.thread_id), time);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.activeGeneration(project2, roleKey);
  }
  rejectCandidate(candidateId, reason) {
    this.db.prepare("UPDATE role_generations SET status='rejected',health='rejected',retirement_reason=?,ended_at=? WHERE id=? AND status='bootstrapping'").run(compactText(reason, 2e3), nowIso(), candidateId);
  }
  assertCurrent(role, generationNumber) {
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id);
    if (!row || Number(row.generation_number) !== generationNumber) throw new Error("STALE_GENERATION");
    return generationFromRow(row);
  }
  putFact(project2, roleKey, input) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const key = slug(input.fact_key);
    const time = nowIso();
    const id = newId("fact");
    const existing = this.db.prepare("SELECT id FROM role_facts WHERE role_id=? AND fact_key=? AND status='active'").get(role.id, key);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) this.db.prepare("UPDATE role_facts SET status='superseded',updated_at=? WHERE id=?").run(time, String(existing.id));
      this.db.prepare(`INSERT INTO role_facts(id,role_id,fact_key,kind,content,authority,source,architecture_epoch,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        id,
        role.id,
        key,
        input.kind,
        compactText(input.content, 2e4),
        input.authority,
        compactText(input.source, 1e3) || null,
        this.projectEpoch(project2),
        "active",
        time,
        time
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db.prepare("SELECT * FROM role_facts WHERE id=?").get(id);
  }
  listFacts(project2, roleKey, kind) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    return kind ? this.db.prepare("SELECT * FROM role_facts WHERE role_id=? AND status='active' AND kind=? ORDER BY updated_at DESC").all(role.id, kind) : this.db.prepare("SELECT * FROM role_facts WHERE role_id=? AND status='active' ORDER BY kind,updated_at DESC").all(role.id);
  }
  upsertTask(project2, input) {
    this.ensureProject(project2);
    const time = nowIso();
    const id = input.task_id || newId("task");
    const role = input.owner_role ? this.getRole(project2, input.owner_role) : null;
    this.db.prepare(`INSERT INTO tasks(id,project_id,owner_role_id,title,goal,status,scope,acceptance_criteria,payload,architecture_epoch,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_role_id=excluded.owner_role_id,title=excluded.title,
      goal=excluded.goal,status=excluded.status,scope=excluded.scope,acceptance_criteria=excluded.acceptance_criteria,
      payload=excluded.payload,updated_at=excluded.updated_at`).run(
      id,
      project2.id,
      role?.id || null,
      compactText(input.title, 300),
      compactText(input.goal, 5e3),
      input.status || "pending",
      compactText(input.scope, 2e3),
      JSON.stringify(uniqueStrings(input.acceptance_criteria)),
      JSON.stringify(input.payload ?? {}),
      this.projectEpoch(project2),
      time,
      time
    );
    if (input.depends_on !== void 0) {
      this.db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
      const insert = this.db.prepare("INSERT INTO task_dependencies(task_id,depends_on) VALUES(?,?)");
      for (const dependency of uniqueStrings(input.depends_on)) insert.run(id, dependency);
    }
    return this.db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(id, project2.id);
  }
  taskGraph(project2) {
    this.ensureProject(project2);
    return this.db.prepare(`SELECT t.*,r.role_key owner_role,
      coalesce((SELECT json_group_array(depends_on) FROM task_dependencies d WHERE d.task_id=t.id),'[]') dependencies
      FROM tasks t LEFT JOIN roles r ON r.id=t.owner_role_id WHERE t.project_id=? ORDER BY t.created_at`).all(project2.id);
  }
  sendMessage(project2, input) {
    const from = this.getRole(project2, input.from_role);
    const to = this.getRole(project2, input.to_role);
    if (!from || !to) throw new Error("UNKNOWN_MESSAGE_ROLE");
    if ((from.role_key === "liaison" || to.role_key === "liaison") && from.role_key !== "coordinator" && to.role_key !== "coordinator") {
      throw new Error("LIAISON_ROUTE_REQUIRES_COORDINATOR");
    }
    this.assertCurrent(from, input.from_generation);
    if (input.architecture_epoch !== this.projectEpoch(project2)) throw new Error("STALE_ARCHITECTURE_EPOCH");
    const id = input.message_id || newId("msg");
    const time = nowIso();
    this.db.prepare(`INSERT INTO messages(id,project_id,type,from_role_id,to_role_id,from_generation,task_id,scope,architecture_epoch,payload,evidence_refs,reply_to,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(
      id,
      project2.id,
      input.type,
      from.id,
      to.id,
      input.from_generation,
      input.task_id || null,
      compactText(input.scope, 2e3),
      input.architecture_epoch,
      JSON.stringify(input.payload),
      JSON.stringify(uniqueStrings(input.evidence_refs)),
      input.reply_to || null,
      "pending",
      time
    );
    const row = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id WHERE m.id=?`).get(id);
    const conflicts = row.type !== input.type || row.from_role !== from.role_key || row.to_role !== to.role_key || Number(row.from_generation) !== input.from_generation || Number(row.architecture_epoch) !== input.architecture_epoch || String(row.task_id || "") !== String(input.task_id || "") || String(row.scope || "") !== compactText(input.scope, 2e3) || String(row.reply_to || "") !== String(input.reply_to || "") || stableJson(parseJson(row.payload, null)) !== stableJson(input.payload) || stableJson(parseJson(row.evidence_refs, [])) !== stableJson(uniqueStrings(input.evidence_refs));
    if (conflicts) throw new Error("MESSAGE_ID_CONFLICT");
    return row;
  }
  inbox(project2, roleKey, includeAcknowledged = false) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const statuses = includeAcknowledged ? "('pending','delivered','acknowledged')" : "('pending','delivered')";
    const rows = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id
      WHERE m.to_role_id=? AND m.status IN ${statuses} ORDER BY m.created_at LIMIT 100`).all(role.id);
    const time = nowIso();
    this.db.prepare("UPDATE messages SET status='delivered',delivered_at=coalesce(delivered_at,?) WHERE to_role_id=? AND status='pending'").run(time, role.id);
    return rows.map((row) => ({ ...row, payload: parseJson(row.payload, {}), evidence_refs: parseJson(row.evidence_refs, []) }));
  }
  acknowledgeMessage(project2, roleKey, messageId) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    this.db.prepare("UPDATE messages SET status='acknowledged',acknowledged_at=? WHERE id=? AND to_role_id=?").run(nowIso(), messageId, role.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND to_role_id=?").get(messageId, role.id);
    if (!row) throw new Error("MESSAGE_NOT_FOUND");
    return row;
  }
  claimMessageWake(project2, messageId) {
    this.ensureProject(project2);
    const time = nowIso();
    const claimed = this.db.prepare(`UPDATE messages SET wake_status='running',wake_error=NULL,wake_started_at=?,wake_completed_at=NULL
      WHERE id=? AND project_id=? AND wake_status IN ('idle','failed')`).run(time, messageId, project2.id);
    if (Number(claimed.changes) === 0) return null;
    return this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project2.id);
  }
  finishMessageWake(project2, messageId) {
    this.db.prepare("UPDATE messages SET wake_status='completed',wake_error=NULL,wake_completed_at=? WHERE id=? AND project_id=?").run(nowIso(), messageId, project2.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project2.id);
    if (!row) throw new Error("MESSAGE_NOT_FOUND");
    return row;
  }
  failMessageWake(project2, messageId, error) {
    this.db.prepare("UPDATE messages SET wake_status='failed',wake_error=?,wake_completed_at=? WHERE id=? AND project_id=?").run(compactText(error, 4e3), nowIso(), messageId, project2.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project2.id);
    if (!row) throw new Error("MESSAGE_NOT_FOUND");
    return row;
  }
  message(project2, messageId) {
    const row = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id WHERE m.id=? AND m.project_id=?`).get(messageId, project2.id);
    return row ? { ...row, payload: parseJson(row.payload, {}), evidence_refs: parseJson(row.evidence_refs, []) } : null;
  }
  resetProject(project2) {
    const existing = this.db.prepare("SELECT id,root,name FROM projects WHERE id=?").get(project2.id);
    if (!existing) return { project_id: project2.id, root: project2.root, deleted: false, counts: {} };
    const counts = {
      roles: Number(this.db.prepare("SELECT count(*) n FROM roles WHERE project_id=?").get(project2.id).n),
      generations: Number(this.db.prepare("SELECT count(*) n FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE r.project_id=?").get(project2.id).n),
      tasks: Number(this.db.prepare("SELECT count(*) n FROM tasks WHERE project_id=?").get(project2.id).n),
      messages: Number(this.db.prepare("SELECT count(*) n FROM messages WHERE project_id=?").get(project2.id).n),
      events: Number(this.db.prepare("SELECT count(*) n FROM events WHERE project_id=?").get(project2.id).n)
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM events WHERE project_id=?").run(project2.id);
      this.db.prepare("DELETE FROM messages WHERE project_id=?").run(project2.id);
      this.db.prepare("DELETE FROM change_envelopes WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)").run(project2.id);
      this.db.prepare("DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) OR depends_on IN (SELECT id FROM tasks WHERE project_id=?)").run(project2.id, project2.id);
      this.db.prepare("DELETE FROM tasks WHERE project_id=?").run(project2.id);
      this.db.prepare("DELETE FROM rotations WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project2.id);
      this.db.prepare("DELETE FROM role_leases WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project2.id);
      this.db.prepare("DELETE FROM role_facts WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project2.id);
      this.db.prepare("DELETE FROM role_generations WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project2.id);
      this.db.prepare("DELETE FROM roles WHERE project_id=?").run(project2.id);
      this.db.prepare("DELETE FROM projects WHERE id=?").run(project2.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { project_id: project2.id, root: existing.root, deleted: true, counts };
  }
  advanceArchitecture(project2, reason) {
    this.ensureProject(project2);
    const time = nowIso();
    this.db.prepare("UPDATE projects SET architecture_epoch=architecture_epoch+1,updated_at=? WHERE id=?").run(time, project2.id);
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(project2.id);
    this.recordEvent(project2, { event_type: "architecture_advanced", event_key: `architecture:${row.architecture_epoch}`, payload: { reason } });
    return row;
  }
  createEnvelope(project2, input) {
    const role = this.getRole(project2, input.owner_role);
    if (!role) throw new Error(`Unknown role: ${input.owner_role}`);
    const task = this.db.prepare("SELECT id FROM tasks WHERE id=? AND project_id=?").get(input.task_id, project2.id);
    if (!task) throw new Error("TASK_NOT_FOUND");
    const id = newId("env");
    const time = nowIso();
    this.db.prepare(`INSERT INTO change_envelopes(id,task_id,owner_role_id,architecture_epoch,intent,allowed_scope,expected_symbols,constraints,non_goals,tests,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.task_id,
      role.id,
      this.projectEpoch(project2),
      compactText(input.intent, 5e3),
      JSON.stringify(uniqueStrings(input.allowed_scope)),
      JSON.stringify(uniqueStrings(input.expected_symbols)),
      JSON.stringify(uniqueStrings(input.constraints)),
      JSON.stringify(uniqueStrings(input.non_goals)),
      JSON.stringify(uniqueStrings(input.tests)),
      time,
      time
    );
    return this.db.prepare("SELECT * FROM change_envelopes WHERE id=?").get(id);
  }
  checkEnvelope(project2, envelopeId, actualPaths) {
    const row = this.db.prepare(`SELECT e.* FROM change_envelopes e JOIN tasks t ON t.id=e.task_id WHERE e.id=? AND t.project_id=?`).get(envelopeId, project2.id);
    if (!row) throw new Error("ENVELOPE_NOT_FOUND");
    if (Number(row.architecture_epoch) !== this.projectEpoch(project2)) throw new Error("STALE_ARCHITECTURE_EPOCH");
    const allowed = parseJson(row.allowed_scope, []);
    const paths = uniqueStrings(actualPaths, 1e3);
    const violations = paths.filter((path) => !matchesAny(path.replace(/\\/g, "/"), allowed));
    const status = violations.length ? "violated" : "passed";
    this.db.prepare("UPDATE change_envelopes SET actual_paths=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify(paths), status, nowIso(), envelopeId);
    return { ...this.db.prepare("SELECT * FROM change_envelopes WHERE id=?").get(envelopeId), violations };
  }
  createRotation(project2, roleKey, reason) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const old = this.activeGeneration(project2, roleKey);
    const id = newId("rotation");
    const time = nowIso();
    const checkpoint = this.context(project2, roleKey);
    this.db.prepare(`INSERT INTO rotations(id,role_id,old_generation_id,state,reason,checkpoint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, role.id, old?.id || null, "ROTATION_PENDING", compactText(reason, 2e3), JSON.stringify(checkpoint), time, time);
    return this.db.prepare("SELECT * FROM rotations WHERE id=?").get(id);
  }
  updateRotation(rotationId, state, input = {}) {
    const time = nowIso();
    this.db.prepare(`UPDATE rotations SET state=?,candidate_generation_id=coalesce(?,candidate_generation_id),error=coalesce(?,error),
      updated_at=?,completed_at=CASE WHEN ? IN ('COMPLETED','FAILED') THEN ? ELSE completed_at END WHERE id=?`).run(state, input.candidateId || null, input.error || null, time, state, time, rotationId);
    const row = this.db.prepare("SELECT * FROM rotations WHERE id=?").get(rotationId);
    if (!row) throw new Error("ROTATION_NOT_FOUND");
    return row;
  }
  validateBootstrap(project2, roleKey, response) {
    const context = this.context(project2, roleKey);
    const role = context.role;
    const errors = [];
    if (response.role_id !== role.role_key) errors.push("role_id mismatch");
    if (response.mission !== role.mission) errors.push("mission mismatch");
    if (JSON.stringify(response.owned_domains) !== JSON.stringify(role.owned_domains)) errors.push("owned_domains mismatch");
    if (response.architecture_epoch !== Number(context.project.architecture_epoch)) errors.push("architecture_epoch mismatch");
    const invariants = context.facts.filter((fact) => fact.kind === "invariant").map((fact) => String(fact.content));
    if (JSON.stringify(response.critical_invariants) !== JSON.stringify(invariants)) errors.push("critical_invariants mismatch");
    return { ok: errors.length === 0, errors };
  }
  recordEvent(project2, input) {
    this.ensureProject(project2);
    const result = this.db.prepare(`INSERT INTO events(id,project_id,role_id,generation_id,event_key,event_type,payload,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).run(
      newId("evt"),
      project2.id,
      input.role_id || null,
      input.generation_id || null,
      input.event_key || null,
      input.event_type,
      JSON.stringify(input.payload ?? null),
      nowIso()
    );
    return Number(result.changes) > 0;
  }
  observeGeneration(project2, threadId, input) {
    const binding = this.getGenerationByThread(project2, threadId);
    if (!binding) return null;
    const inserted = this.recordEvent(project2, { event_type: input.event, ...input.eventKey ? { event_key: input.eventKey } : {}, role_id: binding.role.id, generation_id: binding.generation.id });
    if (!inserted) return this.getGenerationByThread(project2, threadId).generation;
    const time = nowIso();
    if (input.event === "turn") this.db.prepare("UPDATE role_generations SET turn_count=turn_count+1,last_seen_at=? WHERE id=?").run(time, binding.generation.id);
    else if (input.event === "compact") this.db.prepare(`UPDATE role_generations SET compact_count=compact_count+1,
      health=CASE WHEN compact_count+1>=2 THEN 'rotation_required' ELSE 'aging' END,last_seen_at=? WHERE id=? AND status='active'`).run(time, binding.generation.id);
    else this.db.prepare("UPDATE role_generations SET last_seen_at=? WHERE id=?").run(time, binding.generation.id);
    if (input.tokenUsage !== void 0) this.db.prepare("UPDATE role_generations SET token_usage=max(token_usage,?) WHERE id=?").run(input.tokenUsage, binding.generation.id);
    return this.getGenerationByThread(project2, threadId).generation;
  }
  context(project2, roleKey) {
    const projectRow = this.ensureProject(project2);
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const active = this.activeGeneration(project2, roleKey);
    const facts = this.listFacts(project2, roleKey);
    const tasks = this.db.prepare("SELECT * FROM tasks WHERE owner_role_id=? AND status NOT IN ('completed','cancelled') ORDER BY updated_at DESC").all(role.id);
    const messages = this.db.prepare("SELECT count(*) count FROM messages WHERE to_role_id=? AND status IN ('pending','delivered')").get(role.id);
    return {
      project: { id: project2.id, root: project2.root, name: project2.name, constitution: projectRow.constitution, architecture_epoch: Number(projectRow.architecture_epoch) },
      role,
      active_generation: active,
      facts,
      tasks,
      pending_messages: Number(messages.count),
      context_hash: stableHash({ project: projectRow.constitution, epoch: projectRow.architecture_epoch, role, facts, tasks })
    };
  }
  roleAnchor(project2, roleKey, generationOverride) {
    const context = this.context(project2, roleKey);
    const role = context.role;
    const generation = generationOverride ?? context.active_generation;
    const facts = context.facts;
    const invariants = facts.filter((fact) => fact.kind === "invariant").slice(0, 8);
    const tasks = context.tasks;
    const interactionContract = role.role_key === "liaison" ? "Interaction contract: you are the user's sole conversational entry point. Clarify intent, send structured requests and decisions to role://coordinator, and translate its questions, progress, blockers, and verified results for the user. Do not perform internal coordination or implementation yourself." : role.role_key === "coordinator" ? "Interaction contract: receive user intent from role://liaison and return questions, progress, blockers, and results through role://liaison; do not require the user to contact internal roles." : "Interaction contract: communicate user-facing questions and results through role://coordinator, which routes them through role://liaison.";
    return [
      "[Codex Role Runtime]",
      `Role: ${role.name} (role://${role.role_key})`,
      `Generation: ${generation?.generation_number ?? "unbound"}${generation ? ` (${generation.status})` : ""}; Architecture epoch: ${context.project.architecture_epoch}`,
      `Mission: ${role.mission}`,
      `Owns: ${role.owned_domains.join(", ") || "none declared"}`,
      `Does not own: ${role.excluded_domains.join(", ") || "none declared"}`,
      `Policy: ${role.policy.mode}; escalate: ${role.escalation_rules.join(" | ") || "none declared"}`,
      `Active tasks: ${tasks.map((task) => `${task.id}:${task.title}`).join(" | ") || "none"}`,
      `Critical invariants: ${invariants.map((fact) => fact.content).join(" | ") || "none recorded"}`,
      `Pending typed messages: ${context.pending_messages}`,
      interactionContract,
      "Address other persistent roles by role:// key. Never treat this thread id as the role identity."
    ].join("\n");
  }
  status(project2) {
    const projectRow = this.ensureProject(project2);
    const counts = this.db.prepare(`SELECT
      (SELECT count(*) FROM roles WHERE project_id=?) roles,
      (SELECT count(*) FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE r.project_id=? AND g.status='active') active_generations,
      (SELECT count(*) FROM messages WHERE project_id=? AND status IN ('pending','delivered')) open_messages,
      (SELECT count(*) FROM tasks WHERE project_id=? AND status NOT IN ('completed','cancelled')) open_tasks`).get(project2.id, project2.id, project2.id, project2.id);
    const rotations = this.db.prepare(`SELECT x.*,r.role_key FROM rotations x JOIN roles r ON r.id=x.role_id
      WHERE r.project_id=? AND x.state NOT IN ('COMPLETED','FAILED') ORDER BY x.created_at`).all(project2.id);
    return { project: { ...project2, architecture_epoch: Number(projectRow.architecture_epoch), constitution: projectRow.constitution }, roles: this.listRoles(project2), counts, open_rotations: rotations, database_path: this.databasePath };
  }
};

// ../codex-role-runtime/src/topology.ts
var STANDARD_CONSTITUTION = "Preserve modular boundaries, route user communication through the Liaison, route project work through the Coordinator, route cross-domain decisions through semantic owners, and require independent verification.";
var STANDARD_ROLES = [
  {
    role_key: "liaison",
    name: "User Liaison",
    kind: "governance",
    mission: "Serve as the user's conversational gateway: clarify intent, preserve user decisions, translate requests into structured messages for role://coordinator, and relay questions, progress, blockers, and verified results in user-facing language.",
    owned_domains: ["user communication", "intent clarification", "user decisions", "status synthesis"],
    excluded_domains: ["project scheduling", "architecture", "implementation", "verification"],
    escalation_rules: ["Route all internal work through role://coordinator", "Ask the user only when a decision materially changes scope, risk, cost, or outcome"],
    policy: { mode: "read_only", canDelegateTo: ["coordinator"] }
  },
  {
    role_key: "coordinator",
    name: "Coordinator",
    kind: "governance",
    mission: "Maintain project goal, task graph, dependencies, role directory, blockers, and routing without absorbing all module knowledge.",
    owned_domains: ["project goal", "task graph", "routing", "milestones"],
    excluded_domains: ["user-facing conversation", "implementation", "module internals"],
    escalation_rules: ["Exchange user requests, questions, and results only through role://liaison", "Architecture changes go to role://architect"],
    policy: { mode: "read_only", canDelegateTo: ["architect", "verifier"] }
  },
  {
    role_key: "architect",
    name: "Architect",
    kind: "governance",
    mission: "Protect system structure, semantic ownership, dependency direction, cross-module contracts, and migrations.",
    owned_domains: ["architecture", "module boundaries", "dependency direction", "cross-module contracts"],
    excluded_domains: ["user-facing conversation", "routine implementation"],
    escalation_rules: ["Product-direction decisions return to role://coordinator and role://liaison"],
    policy: { mode: "read_only", canDelegateTo: ["verifier"] }
  },
  {
    role_key: "verifier",
    name: "Verifier",
    kind: "governance",
    mission: "Independently verify requirements, architecture consistency, actual diff scope, and objective test evidence.",
    owned_domains: ["verification", "acceptance", "diff review"],
    excluded_domains: ["user-facing conversation", "implementation"],
    escalation_rules: ["Reject unverifiable or out-of-scope changes and report through role://coordinator"],
    policy: { mode: "read_only", freshVerification: true }
  }
];
function initializeStandardTopology(store2, project2, constitution) {
  const existing = store2.ensureProject(project2);
  if (constitution !== void 0 || !String(existing.constitution || "").trim()) {
    store2.configureProject(project2, constitution ?? STANDARD_CONSTITUTION);
  }
  const roles = STANDARD_ROLES.map((role) => store2.defineRole(project2, role));
  return {
    project: store2.configureProject(project2),
    entry_role: "liaison",
    coordinator_role: "coordinator",
    roles
  };
}

// ../codex-role-runtime/src/cli.ts
var raw = process.argv.slice(2);
function option(name) {
  const at = raw.indexOf(name);
  return at >= 0 ? raw[at + 1] : void 0;
}
function positional() {
  return raw.filter((value, index) => !value.startsWith("--") && (index === 0 || !raw[index - 1]?.startsWith("--")));
}
var args = positional();
var command = args[0] || "status";
var cwd = option("--cwd") || process.cwd();
var store = new RoleStore();
var project = resolveProject(cwd);
function generationOptions() {
  const model = option("--model");
  return { ...model ? { model } : {} };
}
try {
  let output;
  switch (command) {
    case "init":
      output = initializeStandardTopology(store, project, option("--constitution"));
      break;
    case "status":
      output = store.status(project);
      break;
    case "doctor": {
      const version = spawnSync("codex", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
      output = { ok: version.status === 0, node: process.version, codex: version.stdout.trim(), database: store.databasePath, project: project.root };
      break;
    }
    case "bind":
      output = store.bindInitial(project, args[1] || "", args[2] || "");
      break;
    case "context":
      output = store.context(project, args[1] || "");
      break;
    case "rotate":
      output = await rotateRoleGeneration(store, project, args[1] || "", option("--reason") || "manual rotation", generationOptions());
      break;
    case "start":
      output = await startRoleGeneration(store, project, args[1] || "", generationOptions());
      break;
    case "open":
    case "continue": {
      const active = store.activeGeneration(project, args[1] || "");
      if (!active) throw new Error("Role has no active generation.");
      store.close();
      const codex = resolveCodexBinary();
      let resumed;
      if (process.platform === "win32" && !codex.toLowerCase().endsWith(".exe")) {
        if (!/^[A-Za-z0-9_-]+$/.test(active.thread_id)) throw new Error("Unsafe thread id in role database.");
        const commandLine = `"${codex.replaceAll('"', "")}" resume ${active.thread_id} -C "%CODEX_ROLE_OPEN_CWD%"`;
        resumed = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
          stdio: "inherit",
          shell: false,
          env: { ...process.env, CODEX_ROLE_OPEN_CWD: project.root }
        });
      } else resumed = spawnSync(codex, ["resume", active.thread_id, "-C", project.root], { stdio: "inherit", shell: false });
      process.exit(resumed.status ?? 1);
    }
    default:
      throw new Error("Usage: codex-role [init|status|doctor|bind <role> <thread>|context <role>|start <role>|rotate <role> --reason <text>|open <role>] [--cwd <path>] [--model <slug>]");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}
`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
} finally {
  try {
    store.close();
  } catch {
  }
}
