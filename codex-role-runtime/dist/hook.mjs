// src/hook.ts
import { readFileSync } from "node:fs";

// src/project.ts
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// src/util.ts
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
function redact(value) {
  const text = JSON.stringify(value ?? null);
  return JSON.parse(text.replace(/(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/gi, "[REDACTED]"));
}

// src/project.ts
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function resolveProject(input2 = process.cwd()) {
  let current = resolve(input2);
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

// src/store.ts
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
    this.root = root || process.env.PLUGIN_DATA || process.env.CODEX_ROLE_RUNTIME_HOME || join(codexHome, "plugin-data", "codex-role-runtime");
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
  ensureProject(project) {
    const time = nowIso();
    this.db.prepare(`INSERT INTO projects(id,root,name,remote,git_common_dir,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,name=excluded.name,remote=excluded.remote,
      git_common_dir=excluded.git_common_dir,updated_at=excluded.updated_at`).run(project.id, project.root, project.name, project.remote, project.gitCommonDir, time, time);
    return this.db.prepare("SELECT * FROM projects WHERE id=?").get(project.id);
  }
  configureProject(project, constitution) {
    this.ensureProject(project);
    if (constitution !== void 0) this.db.prepare("UPDATE projects SET constitution=?,updated_at=? WHERE id=?").run(compactText(constitution, 12e3), nowIso(), project.id);
    return this.db.prepare("SELECT * FROM projects WHERE id=?").get(project.id);
  }
  projectEpoch(project) {
    return Number(this.ensureProject(project).architecture_epoch);
  }
  defineRole(project, input2) {
    this.ensureProject(project);
    const key = slug(input2.role_key);
    const existing = this.db.prepare("SELECT * FROM roles WHERE project_id=? AND role_key=?").get(project.id, key);
    const policy = {
      ...DEFAULT_POLICY,
      ...existing ? parseJson(existing.policy, DEFAULT_POLICY) : {},
      ...input2.policy,
      deniedTools: uniqueStrings(input2.policy?.deniedTools ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).deniedTools : DEFAULT_POLICY.deniedTools)),
      allowedWriteGlobs: uniqueStrings(input2.policy?.allowedWriteGlobs ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).allowedWriteGlobs : [])),
      canDelegateTo: uniqueStrings(input2.policy?.canDelegateTo ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).canDelegateTo : []))
    };
    if (policy.mode === "workspace_write") policy.deniedTools = policy.deniedTools.filter((tool) => !["apply_patch", "Edit", "Write"].includes(tool));
    const time = nowIso();
    const id = existing ? String(existing.id) : newId("role");
    this.db.prepare(`INSERT INTO roles(id,project_id,role_key,name,kind,mission,owned_domains,excluded_domains,escalation_rules,policy,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,role_key) DO UPDATE SET name=excluded.name,kind=excluded.kind,
      mission=excluded.mission,owned_domains=excluded.owned_domains,excluded_domains=excluded.excluded_domains,
      escalation_rules=excluded.escalation_rules,policy=excluded.policy,updated_at=excluded.updated_at`).run(
      id,
      project.id,
      key,
      compactText(input2.name || key, 200),
      input2.kind || "owner",
      compactText(input2.mission, 4e3),
      JSON.stringify(uniqueStrings(input2.owned_domains)),
      JSON.stringify(uniqueStrings(input2.excluded_domains)),
      JSON.stringify(uniqueStrings(input2.escalation_rules)),
      JSON.stringify(policy),
      existing ? String(existing.created_at) : time,
      time
    );
    return this.getRole(project, key);
  }
  getRole(project, roleKey) {
    this.ensureProject(project);
    const row = this.db.prepare("SELECT * FROM roles WHERE project_id=? AND role_key=?").get(project.id, slug(roleKey));
    return row ? roleFromRow(row) : null;
  }
  listRoles(project) {
    this.ensureProject(project);
    const rows = this.db.prepare("SELECT * FROM roles WHERE project_id=? ORDER BY kind,role_key").all(project.id);
    return rows.map((row) => {
      const role = roleFromRow(row);
      const active = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id);
      const count = this.db.prepare("SELECT count(*) count FROM messages WHERE to_role_id=? AND status='pending'").get(role.id);
      return { ...role, active_generation: active ? generationFromRow(active) : null, pending_messages: Number(count.count) };
    });
  }
  getGenerationByThread(project, threadId) {
    this.ensureProject(project);
    const row = this.db.prepare(`SELECT g.*,r.project_id role_project_id,r.role_key,r.name role_name,r.kind role_kind,
      r.mission,r.owned_domains,r.excluded_domains,r.escalation_rules,r.policy,r.created_at role_created_at,r.updated_at role_updated_at
      FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE g.thread_id=? AND r.project_id=?`).get(threadId, project.id);
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
  activeGeneration(project, roleKey) {
    const role = this.getRole(project, roleKey);
    if (!role) return null;
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id);
    return row ? generationFromRow(row) : null;
  }
  bindInitial(project, roleKey, threadId) {
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const existingThread = this.db.prepare("SELECT * FROM role_generations WHERE thread_id=?").get(threadId);
    if (existingThread) {
      if (existingThread.role_id !== role.id) throw new Error("THREAD_ALREADY_BOUND_TO_ANOTHER_ROLE");
      return generationFromRow(existingThread);
    }
    if (this.activeGeneration(project, roleKey)) throw new Error("ROLE_ALREADY_HAS_ACTIVE_GENERATION");
    const time = nowIso();
    const id = newId("gen");
    const epoch = this.projectEpoch(project);
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
    return this.activeGeneration(project, roleKey);
  }
  createCandidate(project, roleKey, threadId, bootstrapHash) {
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const current = this.activeGeneration(project, roleKey);
    const max = this.db.prepare("SELECT coalesce(max(generation_number),0) n FROM role_generations WHERE role_id=?").get(role.id);
    const number = Number(max.n) + 1;
    const time = nowIso();
    const id = newId("gen");
    this.db.prepare(`INSERT INTO role_generations(id,role_id,generation_number,thread_id,status,health,architecture_epoch,bootstrap_hash,started_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, role.id, number, threadId, "bootstrapping", "healthy", this.projectEpoch(project), bootstrapHash || null, time, time);
    if (!current && number !== 1) throw new Error("INVALID_INITIAL_GENERATION");
    return generationFromRow(this.db.prepare("SELECT * FROM role_generations WHERE id=?").get(id));
  }
  activateCandidate(project, roleKey, candidateId, reason) {
    const role = this.getRole(project, roleKey);
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
    return this.activeGeneration(project, roleKey);
  }
  rejectCandidate(candidateId, reason) {
    this.db.prepare("UPDATE role_generations SET status='rejected',health='rejected',retirement_reason=?,ended_at=? WHERE id=? AND status='bootstrapping'").run(compactText(reason, 2e3), nowIso(), candidateId);
  }
  assertCurrent(role, generationNumber) {
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id);
    if (!row || Number(row.generation_number) !== generationNumber) throw new Error("STALE_GENERATION");
    return generationFromRow(row);
  }
  putFact(project, roleKey, input2) {
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const key = slug(input2.fact_key);
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
        input2.kind,
        compactText(input2.content, 2e4),
        input2.authority,
        compactText(input2.source, 1e3) || null,
        this.projectEpoch(project),
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
  listFacts(project, roleKey, kind) {
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    return kind ? this.db.prepare("SELECT * FROM role_facts WHERE role_id=? AND status='active' AND kind=? ORDER BY updated_at DESC").all(role.id, kind) : this.db.prepare("SELECT * FROM role_facts WHERE role_id=? AND status='active' ORDER BY kind,updated_at DESC").all(role.id);
  }
  upsertTask(project, input2) {
    this.ensureProject(project);
    const time = nowIso();
    const id = input2.task_id || newId("task");
    const role = input2.owner_role ? this.getRole(project, input2.owner_role) : null;
    this.db.prepare(`INSERT INTO tasks(id,project_id,owner_role_id,title,goal,status,scope,acceptance_criteria,payload,architecture_epoch,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_role_id=excluded.owner_role_id,title=excluded.title,
      goal=excluded.goal,status=excluded.status,scope=excluded.scope,acceptance_criteria=excluded.acceptance_criteria,
      payload=excluded.payload,updated_at=excluded.updated_at`).run(
      id,
      project.id,
      role?.id || null,
      compactText(input2.title, 300),
      compactText(input2.goal, 5e3),
      input2.status || "pending",
      compactText(input2.scope, 2e3),
      JSON.stringify(uniqueStrings(input2.acceptance_criteria)),
      JSON.stringify(input2.payload ?? {}),
      this.projectEpoch(project),
      time,
      time
    );
    if (input2.depends_on !== void 0) {
      this.db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
      const insert = this.db.prepare("INSERT INTO task_dependencies(task_id,depends_on) VALUES(?,?)");
      for (const dependency of uniqueStrings(input2.depends_on)) insert.run(id, dependency);
    }
    return this.db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(id, project.id);
  }
  taskGraph(project) {
    this.ensureProject(project);
    return this.db.prepare(`SELECT t.*,r.role_key owner_role,
      coalesce((SELECT json_group_array(depends_on) FROM task_dependencies d WHERE d.task_id=t.id),'[]') dependencies
      FROM tasks t LEFT JOIN roles r ON r.id=t.owner_role_id WHERE t.project_id=? ORDER BY t.created_at`).all(project.id);
  }
  sendMessage(project, input2) {
    const from = this.getRole(project, input2.from_role);
    const to = this.getRole(project, input2.to_role);
    if (!from || !to) throw new Error("UNKNOWN_MESSAGE_ROLE");
    if ((from.role_key === "liaison" || to.role_key === "liaison") && from.role_key !== "coordinator" && to.role_key !== "coordinator") {
      throw new Error("LIAISON_ROUTE_REQUIRES_COORDINATOR");
    }
    this.assertCurrent(from, input2.from_generation);
    if (input2.architecture_epoch !== this.projectEpoch(project)) throw new Error("STALE_ARCHITECTURE_EPOCH");
    const id = input2.message_id || newId("msg");
    const time = nowIso();
    this.db.prepare(`INSERT INTO messages(id,project_id,type,from_role_id,to_role_id,from_generation,task_id,scope,architecture_epoch,payload,evidence_refs,reply_to,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(
      id,
      project.id,
      input2.type,
      from.id,
      to.id,
      input2.from_generation,
      input2.task_id || null,
      compactText(input2.scope, 2e3),
      input2.architecture_epoch,
      JSON.stringify(input2.payload),
      JSON.stringify(uniqueStrings(input2.evidence_refs)),
      input2.reply_to || null,
      "pending",
      time
    );
    return this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id WHERE m.id=?`).get(id);
  }
  inbox(project, roleKey, includeAcknowledged = false) {
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const statuses = includeAcknowledged ? "('pending','delivered','acknowledged')" : "('pending','delivered')";
    const rows = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id
      WHERE m.to_role_id=? AND m.status IN ${statuses} ORDER BY m.created_at LIMIT 100`).all(role.id);
    const time = nowIso();
    this.db.prepare("UPDATE messages SET status='delivered',delivered_at=coalesce(delivered_at,?) WHERE to_role_id=? AND status='pending'").run(time, role.id);
    return rows.map((row) => ({ ...row, payload: parseJson(row.payload, {}), evidence_refs: parseJson(row.evidence_refs, []) }));
  }
  acknowledgeMessage(project, roleKey, messageId) {
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    this.db.prepare("UPDATE messages SET status='acknowledged',acknowledged_at=? WHERE id=? AND to_role_id=?").run(nowIso(), messageId, role.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND to_role_id=?").get(messageId, role.id);
    if (!row) throw new Error("MESSAGE_NOT_FOUND");
    return row;
  }
  advanceArchitecture(project, reason) {
    this.ensureProject(project);
    const time = nowIso();
    this.db.prepare("UPDATE projects SET architecture_epoch=architecture_epoch+1,updated_at=? WHERE id=?").run(time, project.id);
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(project.id);
    this.recordEvent(project, { event_type: "architecture_advanced", event_key: `architecture:${row.architecture_epoch}`, payload: { reason } });
    return row;
  }
  createEnvelope(project, input2) {
    const role = this.getRole(project, input2.owner_role);
    if (!role) throw new Error(`Unknown role: ${input2.owner_role}`);
    const task = this.db.prepare("SELECT id FROM tasks WHERE id=? AND project_id=?").get(input2.task_id, project.id);
    if (!task) throw new Error("TASK_NOT_FOUND");
    const id = newId("env");
    const time = nowIso();
    this.db.prepare(`INSERT INTO change_envelopes(id,task_id,owner_role_id,architecture_epoch,intent,allowed_scope,expected_symbols,constraints,non_goals,tests,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input2.task_id,
      role.id,
      this.projectEpoch(project),
      compactText(input2.intent, 5e3),
      JSON.stringify(uniqueStrings(input2.allowed_scope)),
      JSON.stringify(uniqueStrings(input2.expected_symbols)),
      JSON.stringify(uniqueStrings(input2.constraints)),
      JSON.stringify(uniqueStrings(input2.non_goals)),
      JSON.stringify(uniqueStrings(input2.tests)),
      time,
      time
    );
    return this.db.prepare("SELECT * FROM change_envelopes WHERE id=?").get(id);
  }
  checkEnvelope(project, envelopeId, actualPaths) {
    const row = this.db.prepare(`SELECT e.* FROM change_envelopes e JOIN tasks t ON t.id=e.task_id WHERE e.id=? AND t.project_id=?`).get(envelopeId, project.id);
    if (!row) throw new Error("ENVELOPE_NOT_FOUND");
    if (Number(row.architecture_epoch) !== this.projectEpoch(project)) throw new Error("STALE_ARCHITECTURE_EPOCH");
    const allowed = parseJson(row.allowed_scope, []);
    const paths = uniqueStrings(actualPaths, 1e3);
    const violations = paths.filter((path) => !matchesAny(path.replace(/\\/g, "/"), allowed));
    const status = violations.length ? "violated" : "passed";
    this.db.prepare("UPDATE change_envelopes SET actual_paths=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify(paths), status, nowIso(), envelopeId);
    return { ...this.db.prepare("SELECT * FROM change_envelopes WHERE id=?").get(envelopeId), violations };
  }
  createRotation(project, roleKey, reason) {
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const old = this.activeGeneration(project, roleKey);
    const id = newId("rotation");
    const time = nowIso();
    const checkpoint = this.context(project, roleKey);
    this.db.prepare(`INSERT INTO rotations(id,role_id,old_generation_id,state,reason,checkpoint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, role.id, old?.id || null, "ROTATION_PENDING", compactText(reason, 2e3), JSON.stringify(checkpoint), time, time);
    return this.db.prepare("SELECT * FROM rotations WHERE id=?").get(id);
  }
  updateRotation(rotationId, state, input2 = {}) {
    const time = nowIso();
    this.db.prepare(`UPDATE rotations SET state=?,candidate_generation_id=coalesce(?,candidate_generation_id),error=coalesce(?,error),
      updated_at=?,completed_at=CASE WHEN ? IN ('COMPLETED','FAILED') THEN ? ELSE completed_at END WHERE id=?`).run(state, input2.candidateId || null, input2.error || null, time, state, time, rotationId);
    const row = this.db.prepare("SELECT * FROM rotations WHERE id=?").get(rotationId);
    if (!row) throw new Error("ROTATION_NOT_FOUND");
    return row;
  }
  validateBootstrap(project, roleKey, response) {
    const context2 = this.context(project, roleKey);
    const role = context2.role;
    const errors = [];
    if (response.role_id !== role.role_key) errors.push("role_id mismatch");
    if (response.mission !== role.mission) errors.push("mission mismatch");
    if (JSON.stringify(response.owned_domains) !== JSON.stringify(role.owned_domains)) errors.push("owned_domains mismatch");
    if (response.architecture_epoch !== Number(context2.project.architecture_epoch)) errors.push("architecture_epoch mismatch");
    const invariants = context2.facts.filter((fact) => fact.kind === "invariant").map((fact) => String(fact.content));
    if (JSON.stringify(response.critical_invariants) !== JSON.stringify(invariants)) errors.push("critical_invariants mismatch");
    return { ok: errors.length === 0, errors };
  }
  recordEvent(project, input2) {
    this.ensureProject(project);
    const result = this.db.prepare(`INSERT INTO events(id,project_id,role_id,generation_id,event_key,event_type,payload,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).run(
      newId("evt"),
      project.id,
      input2.role_id || null,
      input2.generation_id || null,
      input2.event_key || null,
      input2.event_type,
      JSON.stringify(input2.payload ?? null),
      nowIso()
    );
    return Number(result.changes) > 0;
  }
  observeGeneration(project, threadId, input2) {
    const binding = this.getGenerationByThread(project, threadId);
    if (!binding) return null;
    const inserted = this.recordEvent(project, { event_type: input2.event, ...input2.eventKey ? { event_key: input2.eventKey } : {}, role_id: binding.role.id, generation_id: binding.generation.id });
    if (!inserted) return this.getGenerationByThread(project, threadId).generation;
    const time = nowIso();
    if (input2.event === "turn") this.db.prepare("UPDATE role_generations SET turn_count=turn_count+1,last_seen_at=? WHERE id=?").run(time, binding.generation.id);
    else if (input2.event === "compact") this.db.prepare(`UPDATE role_generations SET compact_count=compact_count+1,
      health=CASE WHEN compact_count+1>=2 THEN 'rotation_required' ELSE 'aging' END,last_seen_at=? WHERE id=? AND status='active'`).run(time, binding.generation.id);
    else this.db.prepare("UPDATE role_generations SET last_seen_at=? WHERE id=?").run(time, binding.generation.id);
    if (input2.tokenUsage !== void 0) this.db.prepare("UPDATE role_generations SET token_usage=max(token_usage,?) WHERE id=?").run(input2.tokenUsage, binding.generation.id);
    return this.getGenerationByThread(project, threadId).generation;
  }
  context(project, roleKey) {
    const projectRow = this.ensureProject(project);
    const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const active = this.activeGeneration(project, roleKey);
    const facts = this.listFacts(project, roleKey);
    const tasks = this.db.prepare("SELECT * FROM tasks WHERE owner_role_id=? AND status NOT IN ('completed','cancelled') ORDER BY updated_at DESC").all(role.id);
    const messages = this.db.prepare("SELECT count(*) count FROM messages WHERE to_role_id=? AND status IN ('pending','delivered')").get(role.id);
    return {
      project: { id: project.id, root: project.root, name: project.name, constitution: projectRow.constitution, architecture_epoch: Number(projectRow.architecture_epoch) },
      role,
      active_generation: active,
      facts,
      tasks,
      pending_messages: Number(messages.count),
      context_hash: stableHash({ project: projectRow.constitution, epoch: projectRow.architecture_epoch, role, facts, tasks })
    };
  }
  roleAnchor(project, roleKey) {
    const context2 = this.context(project, roleKey);
    const role = context2.role;
    const generation = context2.active_generation;
    const facts = context2.facts;
    const invariants = facts.filter((fact) => fact.kind === "invariant").slice(0, 8);
    const tasks = context2.tasks;
    const interactionContract = role.role_key === "liaison" ? "Interaction contract: you are the user's sole conversational entry point. Clarify intent, send structured requests and decisions to role://coordinator, and translate its questions, progress, blockers, and verified results for the user. Do not perform internal coordination or implementation yourself." : role.role_key === "coordinator" ? "Interaction contract: receive user intent from role://liaison and return questions, progress, blockers, and results through role://liaison; do not require the user to contact internal roles." : "Interaction contract: communicate user-facing questions and results through role://coordinator, which routes them through role://liaison.";
    return [
      "[Codex Role Runtime]",
      `Role: ${role.name} (role://${role.role_key})`,
      `Generation: ${generation?.generation_number ?? "unbound"}; Architecture epoch: ${context2.project.architecture_epoch}`,
      `Mission: ${role.mission}`,
      `Owns: ${role.owned_domains.join(", ") || "none declared"}`,
      `Does not own: ${role.excluded_domains.join(", ") || "none declared"}`,
      `Policy: ${role.policy.mode}; escalate: ${role.escalation_rules.join(" | ") || "none declared"}`,
      `Active tasks: ${tasks.map((task) => `${task.id}:${task.title}`).join(" | ") || "none"}`,
      `Critical invariants: ${invariants.map((fact) => fact.content).join(" | ") || "none recorded"}`,
      `Pending typed messages: ${context2.pending_messages}`,
      interactionContract,
      "Address other persistent roles by role:// key. Never treat this thread id as the role identity."
    ].join("\n");
  }
  status(project) {
    const projectRow = this.ensureProject(project);
    const counts = this.db.prepare(`SELECT
      (SELECT count(*) FROM roles WHERE project_id=?) roles,
      (SELECT count(*) FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE r.project_id=? AND g.status='active') active_generations,
      (SELECT count(*) FROM messages WHERE project_id=? AND status IN ('pending','delivered')) open_messages,
      (SELECT count(*) FROM tasks WHERE project_id=? AND status NOT IN ('completed','cancelled')) open_tasks`).get(project.id, project.id, project.id, project.id);
    const rotations = this.db.prepare(`SELECT x.*,r.role_key FROM rotations x JOIN roles r ON r.id=x.role_id
      WHERE r.project_id=? AND x.state NOT IN ('COMPLETED','FAILED') ORDER BY x.created_at`).all(project.id);
    return { project: { ...project, architecture_epoch: Number(projectRow.architecture_epoch), constitution: projectRow.constitution }, roles: this.listRoles(project), counts, open_rotations: rotations, database_path: this.databasePath };
  }
};

// src/topology.ts
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
function isRoleInitializationPrompt(prompt) {
  if (!prompt) return false;
  const normalized = prompt.trim().replace(/[。.!！]+$/u, "").trim().toLowerCase();
  return normalized === "\u521D\u59CB\u5316\u89D2\u8272\u7F16\u6392" || normalized === "\u542F\u52A8\u89D2\u8272\u7F16\u6392" || normalized === "initialize role orchestration";
}
function initializeStandardTopology(store2, project, constitution) {
  const existing = store2.ensureProject(project);
  if (constitution !== void 0 || !String(existing.constitution || "").trim()) {
    store2.configureProject(project, constitution ?? STANDARD_CONSTITUTION);
  }
  const roles = STANDARD_ROLES.map((role) => store2.defineRole(project, role));
  return {
    project: store2.configureProject(project),
    entry_role: "liaison",
    coordinator_role: "coordinator",
    roles
  };
}

// src/hook.ts
function readInput() {
  const raw = readFileSync(0, "utf8");
  const value = JSON.parse(raw);
  if (!value.session_id || !value.cwd || !value.hook_event_name) throw new Error("Invalid Codex hook input.");
  return value;
}
function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
function deny(event, reason) {
  if (event === "UserPromptSubmit") return { decision: "block", reason };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}
function isMutatingShell(value) {
  const command = typeof value === "object" && value ? String(value.command || "") : "";
  return /(^|[;&|]\s*)(rm|del|erase|rmdir|remove-item|move-item|copy-item|mv|cp|mkdir|md|touch|new-item|set-content|add-content)\b|(^|\s)(git\s+(commit|merge|rebase|cherry-pick|reset|checkout|switch|add)|npm\s+(install|update)|pnpm\s+(install|add)|yarn\s+add)\b|(^|[^>])>{1,2}(?!>)/i.test(command);
}
var input = readInput();
var store = new RoleStore();
try {
  const project = resolveProject(input.cwd);
  let binding = store.getGenerationByThread(project, input.session_id);
  if (!binding && input.hook_event_name === "UserPromptSubmit") {
    if (isRoleInitializationPrompt(input.prompt)) {
      initializeStandardTopology(store, project);
      const active = store.activeGeneration(project, "liaison");
      if (active && active.thread_id !== input.session_id) {
        process.stdout.write(JSON.stringify(deny(input.hook_event_name, "USER_LIAISON_ALREADY_ACTIVE: continue the existing User Liaison task, or rotate role://liaison before binding this task.")));
        process.exit(0);
      }
      const generation2 = store.bindInitial(project, "liaison", input.session_id);
      process.stdout.write(JSON.stringify(context(input.hook_event_name, `Role orchestration initialized. This task is the user's communication entry point.
${store.roleAnchor(project, "liaison")}
Send structured user intent to role://coordinator; relay its questions, progress, blockers, and verified results back to the user.`)));
      process.exit(0);
    }
    const claim = input.prompt?.match(/^\s*role:\/\/bind\s+([a-z0-9-]+)\s*$/i);
    if (claim?.[1]) {
      const generation2 = store.bindInitial(project, claim[1], input.session_id);
      binding = store.getGenerationByThread(project, input.session_id);
      process.stdout.write(JSON.stringify(context(input.hook_event_name, `Role binding created at generation ${generation2.generation_number}.
${store.roleAnchor(project, claim[1])}`)));
      process.exit(0);
    }
  }
  if (!binding) {
    store.recordEvent(project, { event_type: `unbound:${input.hook_event_name}`, event_key: `${input.session_id}:${input.turn_id || input.source || input.hook_event_name}:${input.hook_event_name}`, payload: redact(input) });
    process.stdout.write("{}");
    process.exit(0);
  }
  const { role, generation } = binding;
  const stale = generation.status !== "active";
  const eventKey = `${input.session_id}:${input.turn_id || input.tool_use_id || input.trigger || input.source || input.hook_event_name}:${input.hook_event_name}`;
  switch (input.hook_event_name) {
    case "SessionStart":
      if (stale) process.stdout.write(JSON.stringify({ continue: false, stopReason: `STALE_GENERATION: role://${role.role_key} now uses another thread.` }));
      else {
        store.observeGeneration(project, input.session_id, { event: "session_start", eventKey });
        process.stdout.write(JSON.stringify(context("SessionStart", store.roleAnchor(project, role.role_key))));
      }
      break;
    case "UserPromptSubmit":
      if (stale) process.stdout.write(JSON.stringify(deny("UserPromptSubmit", `STALE_GENERATION: this thread is retired for role://${role.role_key}. Open its current generation.`)));
      else {
        store.observeGeneration(project, input.session_id, { event: "turn", eventKey });
        process.stdout.write(JSON.stringify(context("UserPromptSubmit", store.roleAnchor(project, role.role_key))));
      }
      break;
    case "PreToolUse": {
      if (stale) {
        process.stdout.write(JSON.stringify(deny("PreToolUse", `STALE_GENERATION: retired generation ${generation.generation_number} cannot use tools.`)));
        break;
      }
      const tool = input.tool_name || "";
      if (matchesAny(tool, role.policy.deniedTools) || role.policy.mode === "read_only" && tool === "Bash" && isMutatingShell(input.tool_input)) {
        process.stdout.write(JSON.stringify(deny("PreToolUse", `Role policy denies ${tool} for role://${role.role_key} (${role.policy.mode}). Delegate implementation to a writable worker.`)));
      } else process.stdout.write(JSON.stringify(context("PreToolUse", `Role policy active for role://${role.role_key}; architecture epoch ${generation.architecture_epoch}.`)));
      break;
    }
    case "PostCompact":
      store.observeGeneration(project, input.session_id, { event: "compact", eventKey });
      process.stdout.write("{}");
      break;
    case "PreCompact":
      store.recordEvent(project, { event_type: "pre_compact", event_key: eventKey, role_id: role.id, generation_id: generation.id, payload: { trigger: input.trigger } });
      process.stdout.write("{}");
      break;
    default:
      store.recordEvent(project, { event_type: input.hook_event_name, event_key: eventKey, role_id: role.id, generation_id: generation.id, payload: redact(input) });
      store.observeGeneration(project, input.session_id, { event: "seen", eventKey: `${eventKey}:seen` });
      process.stdout.write("{}");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
} finally {
  store.close();
}
