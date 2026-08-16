import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BootstrapResponse, FactKind, GenerationRecord, MessageType,
  ProjectContext, RoleKind, RolePolicy, RoleRecord, RotationState
} from "./types.js";
import { compactText, matchesAny, newId, nowIso, parseJson, slug, stableHash, stableJson, uniqueStrings } from "./util.js";

type Row = Record<string, unknown>;

export interface DefineRoleInput {
  role_key: string;
  name?: string;
  kind?: RoleKind;
  mission: string;
  owned_domains?: string[];
  excluded_domains?: string[];
  escalation_rules?: string[];
  policy?: Partial<RolePolicy>;
}

export interface SendMessageInput {
  message_id?: string;
  type: MessageType;
  from_role: string;
  to_role: string;
  from_generation: number;
  task_id?: string;
  scope?: string;
  architecture_epoch: number;
  payload: unknown;
  evidence_refs?: string[];
  reply_to?: string;
}

const DEFAULT_POLICY: RolePolicy = {
  mode: "read_only",
  deniedTools: ["apply_patch", "Edit", "Write"],
  allowedWriteGlobs: [],
  canDelegateTo: [],
  freshVerification: false
};

function roleFromRow(row: Row): RoleRecord {
  return {
    ...(row as unknown as RoleRecord),
    kind: row.kind as RoleKind,
    owned_domains: parseJson(row.owned_domains, []),
    excluded_domains: parseJson(row.excluded_domains, []),
    escalation_rules: parseJson(row.escalation_rules, []),
    policy: parseJson(row.policy, DEFAULT_POLICY)
  };
}

function generationFromRow(row: Row): GenerationRecord {
  return {
    ...(row as unknown as GenerationRecord),
    generation_number: Number(row.generation_number),
    architecture_epoch: Number(row.architecture_epoch),
    turn_count: Number(row.turn_count), compact_count: Number(row.compact_count), token_usage: Number(row.token_usage)
  };
}

export class RoleStore {
  readonly root: string;
  readonly databasePath: string;
  readonly db: DatabaseSync;

  constructor(root?: string) {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    this.root = root || process.env.CODEX_ROLE_RUNTIME_HOME || process.env.PLUGIN_DATA || join(codexHome, "plugin-data", "codex-role-runtime");
    mkdirSync(this.root, { recursive: true });
    this.databasePath = join(this.root, "role-runtime.sqlite3");
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
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

  private migrateMessageWakeState(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(messages)").all() as Row[]).map((row) => String(row.name)));
    if (!columns.has("wake_status")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_status TEXT NOT NULL DEFAULT 'idle' CHECK(wake_status IN ('idle','running','completed','failed'))");
    if (!columns.has("wake_error")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_error TEXT");
    if (!columns.has("wake_started_at")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_started_at TEXT");
    if (!columns.has("wake_completed_at")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_completed_at TEXT");
  }

  private migrateLegacyRoleFacts(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='role_facts'").get() as Row | undefined;
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
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  ensureProject(project: ProjectContext): Row {
    const time = nowIso();
    this.db.prepare(`INSERT INTO projects(id,root,name,remote,git_common_dir,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,name=excluded.name,remote=excluded.remote,
      git_common_dir=excluded.git_common_dir,updated_at=excluded.updated_at`)
      .run(project.id, project.root, project.name, project.remote, project.gitCommonDir, time, time);
    return this.db.prepare("SELECT * FROM projects WHERE id=?").get(project.id) as Row;
  }

  configureProject(project: ProjectContext, constitution?: string): Row {
    this.ensureProject(project);
    if (constitution !== undefined) this.db.prepare("UPDATE projects SET constitution=?,updated_at=? WHERE id=?")
      .run(compactText(constitution, 12_000), nowIso(), project.id);
    return this.db.prepare("SELECT * FROM projects WHERE id=?").get(project.id) as Row;
  }

  projectEpoch(project: ProjectContext): number { return Number(this.ensureProject(project).architecture_epoch); }

  defineRole(project: ProjectContext, input: DefineRoleInput): RoleRecord {
    this.ensureProject(project);
    const key = slug(input.role_key);
    const existing = this.db.prepare("SELECT * FROM roles WHERE project_id=? AND role_key=?").get(project.id, key) as Row | undefined;
    const policy: RolePolicy = {
      ...DEFAULT_POLICY, ...(existing ? parseJson(existing.policy, DEFAULT_POLICY) : {}), ...input.policy,
      deniedTools: uniqueStrings(input.policy?.deniedTools ?? (existing ? parseJson<RolePolicy>(existing.policy, DEFAULT_POLICY).deniedTools : DEFAULT_POLICY.deniedTools)),
      allowedWriteGlobs: uniqueStrings(input.policy?.allowedWriteGlobs ?? (existing ? parseJson<RolePolicy>(existing.policy, DEFAULT_POLICY).allowedWriteGlobs : [])),
      canDelegateTo: uniqueStrings(input.policy?.canDelegateTo ?? (existing ? parseJson<RolePolicy>(existing.policy, DEFAULT_POLICY).canDelegateTo : []))
    };
    if (policy.mode === "workspace_write") policy.deniedTools = policy.deniedTools.filter((tool) => !["apply_patch", "Edit", "Write"].includes(tool));
    const time = nowIso();
    const id = existing ? String(existing.id) : newId("role");
    this.db.prepare(`INSERT INTO roles(id,project_id,role_key,name,kind,mission,owned_domains,excluded_domains,escalation_rules,policy,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,role_key) DO UPDATE SET name=excluded.name,kind=excluded.kind,
      mission=excluded.mission,owned_domains=excluded.owned_domains,excluded_domains=excluded.excluded_domains,
      escalation_rules=excluded.escalation_rules,policy=excluded.policy,updated_at=excluded.updated_at`)
      .run(id, project.id, key, compactText(input.name || key, 200), input.kind || "owner", compactText(input.mission, 4000),
        JSON.stringify(uniqueStrings(input.owned_domains)), JSON.stringify(uniqueStrings(input.excluded_domains)),
        JSON.stringify(uniqueStrings(input.escalation_rules)), JSON.stringify(policy), existing ? String(existing.created_at) : time, time);
    return this.getRole(project, key)!;
  }

  getRole(project: ProjectContext, roleKey: string): RoleRecord | null {
    this.ensureProject(project);
    const row = this.db.prepare("SELECT * FROM roles WHERE project_id=? AND role_key=?").get(project.id, slug(roleKey)) as Row | undefined;
    return row ? roleFromRow(row) : null;
  }

  listRoles(project: ProjectContext): Array<RoleRecord & { active_generation: GenerationRecord | null; pending_messages: number }> {
    this.ensureProject(project);
    const rows = this.db.prepare("SELECT * FROM roles WHERE project_id=? ORDER BY kind,role_key").all(project.id) as Row[];
    return rows.map((row) => {
      const role = roleFromRow(row);
      const active = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id) as Row | undefined;
      const count = this.db.prepare("SELECT count(*) count FROM messages WHERE to_role_id=? AND status='pending'").get(role.id) as Row;
      return { ...role, active_generation: active ? generationFromRow(active) : null, pending_messages: Number(count.count) };
    });
  }

  getGenerationByThread(project: ProjectContext, threadId: string): { role: RoleRecord; generation: GenerationRecord } | null {
    this.ensureProject(project);
    const row = this.db.prepare(`SELECT g.*,r.project_id role_project_id,r.role_key,r.name role_name,r.kind role_kind,
      r.mission,r.owned_domains,r.excluded_domains,r.escalation_rules,r.policy,r.created_at role_created_at,r.updated_at role_updated_at
      FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE g.thread_id=? AND r.project_id=?`).get(threadId, project.id) as Row | undefined;
    if (!row) return null;
    const role = roleFromRow({
      id: row.role_id, project_id: row.role_project_id, role_key: row.role_key, name: row.role_name, kind: row.role_kind,
      mission: row.mission, owned_domains: row.owned_domains, excluded_domains: row.excluded_domains,
      escalation_rules: row.escalation_rules, policy: row.policy, created_at: row.role_created_at, updated_at: row.role_updated_at
    });
    return { role, generation: generationFromRow(row) };
  }

  activeGeneration(project: ProjectContext, roleKey: string): GenerationRecord | null {
    const role = this.getRole(project, roleKey); if (!role) return null;
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id) as Row | undefined;
    return row ? generationFromRow(row) : null;
  }

  bootstrappingGeneration(project: ProjectContext, roleKey: string): GenerationRecord | null {
    const role = this.getRole(project, roleKey); if (!role) return null;
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='bootstrapping'").get(role.id) as Row | undefined;
    return row ? generationFromRow(row) : null;
  }

  openRotation(project: ProjectContext, roleKey: string): Row | null {
    const role = this.getRole(project, roleKey); if (!role) return null;
    const row = this.db.prepare("SELECT * FROM rotations WHERE role_id=? AND state NOT IN ('COMPLETED','FAILED') ORDER BY created_at DESC LIMIT 1").get(role.id) as Row | undefined;
    return row || null;
  }

  bindInitial(project: ProjectContext, roleKey: string, threadId: string): GenerationRecord {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const existingThread = this.db.prepare("SELECT * FROM role_generations WHERE thread_id=?").get(threadId) as Row | undefined;
    if (existingThread) {
      if (existingThread.role_id !== role.id) throw new Error("THREAD_ALREADY_BOUND_TO_ANOTHER_ROLE");
      return generationFromRow(existingThread);
    }
    if (this.activeGeneration(project, roleKey)) throw new Error("ROLE_ALREADY_HAS_ACTIVE_GENERATION");
    const time = nowIso(); const id = newId("gen"); const epoch = this.projectEpoch(project);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO role_generations(id,role_id,generation_number,thread_id,status,health,architecture_epoch,started_at,last_seen_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, role.id, 1, threadId, "active", "healthy", epoch, time, time);
      this.db.prepare("INSERT INTO role_leases(role_id,generation_id,lease_epoch,owner,updated_at) VALUES(?,?,?,?,?)")
        .run(role.id, id, 1, threadId, time);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.activeGeneration(project, roleKey)!;
  }

  createCandidate(project: ProjectContext, roleKey: string, threadId: string, bootstrapHash?: string): GenerationRecord {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const max = this.db.prepare("SELECT coalesce(max(generation_number),0) n FROM role_generations WHERE role_id=?").get(role.id) as Row;
    const number = Number(max.n) + 1; const time = nowIso(); const id = newId("gen");
    this.db.prepare(`INSERT INTO role_generations(id,role_id,generation_number,thread_id,status,health,architecture_epoch,bootstrap_hash,started_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, role.id, number, threadId, "bootstrapping", "healthy", this.projectEpoch(project), bootstrapHash || null, time, time);
    return generationFromRow(this.db.prepare("SELECT * FROM role_generations WHERE id=?").get(id) as Row);
  }

  activateCandidate(project: ProjectContext, roleKey: string, candidateId: string, reason: string): GenerationRecord {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const candidate = this.db.prepare("SELECT * FROM role_generations WHERE id=? AND role_id=?").get(candidateId, role.id) as Row | undefined;
    if (!candidate || candidate.status !== "bootstrapping") throw new Error("CANDIDATE_NOT_BOOTSTRAPPING");
    const time = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE role_generations SET status='retired',health='retired',retirement_reason=?,ended_at=? WHERE role_id=? AND status='active'")
        .run(compactText(reason, 1000), time, role.id);
      this.db.prepare("UPDATE role_generations SET status='active',health='healthy',last_seen_at=? WHERE id=?").run(time, candidateId);
      const lease = this.db.prepare("SELECT lease_epoch FROM role_leases WHERE role_id=?").get(role.id) as Row | undefined;
      this.db.prepare(`INSERT INTO role_leases(role_id,generation_id,lease_epoch,owner,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(role_id) DO UPDATE SET generation_id=excluded.generation_id,lease_epoch=excluded.lease_epoch,owner=excluded.owner,updated_at=excluded.updated_at`)
        .run(role.id, candidateId, Number(lease?.lease_epoch || 0) + 1, String(candidate.thread_id), time);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.activeGeneration(project, roleKey)!;
  }

  rejectCandidate(candidateId: string, reason: string): void {
    this.db.prepare("UPDATE role_generations SET status='rejected',health='rejected',retirement_reason=?,ended_at=? WHERE id=? AND status='bootstrapping'")
      .run(compactText(reason, 2000), nowIso(), candidateId);
  }

  assertCurrent(role: RoleRecord, generationNumber: number): GenerationRecord {
    const row = this.db.prepare("SELECT * FROM role_generations WHERE role_id=? AND status='active'").get(role.id) as Row | undefined;
    if (!row || Number(row.generation_number) !== generationNumber) throw new Error("STALE_GENERATION");
    return generationFromRow(row);
  }

  putFact(project: ProjectContext, roleKey: string, input: { fact_key: string; kind: FactKind; content: string; authority: string; source?: string }): Row {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const key = slug(input.fact_key); const time = nowIso(); const id = newId("fact");
    const existing = this.db.prepare("SELECT id FROM role_facts WHERE role_id=? AND fact_key=? AND status='active'").get(role.id, key) as Row | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) this.db.prepare("UPDATE role_facts SET status='superseded',updated_at=? WHERE id=?").run(time, String(existing.id));
      this.db.prepare(`INSERT INTO role_facts(id,role_id,fact_key,kind,content,authority,source,architecture_epoch,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, role.id, key, input.kind, compactText(input.content, 20_000), input.authority,
          compactText(input.source, 1000) || null, this.projectEpoch(project), "active", time, time);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.db.prepare("SELECT * FROM role_facts WHERE id=?").get(id) as Row;
  }

  listFacts(project: ProjectContext, roleKey: string, kind?: FactKind): Row[] {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    return (kind
      ? this.db.prepare("SELECT * FROM role_facts WHERE role_id=? AND status='active' AND kind=? ORDER BY updated_at DESC").all(role.id, kind)
      : this.db.prepare("SELECT * FROM role_facts WHERE role_id=? AND status='active' ORDER BY kind,updated_at DESC").all(role.id)) as Row[];
  }

  upsertTask(project: ProjectContext, input: { task_id?: string; owner_role?: string; title: string; goal: string; status?: string; scope?: string; acceptance_criteria?: string[]; payload?: unknown; depends_on?: string[] }): Row {
    this.ensureProject(project); const time = nowIso(); const id = input.task_id || newId("task");
    const role = input.owner_role ? this.getRole(project, input.owner_role) : null;
    this.db.prepare(`INSERT INTO tasks(id,project_id,owner_role_id,title,goal,status,scope,acceptance_criteria,payload,architecture_epoch,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_role_id=excluded.owner_role_id,title=excluded.title,
      goal=excluded.goal,status=excluded.status,scope=excluded.scope,acceptance_criteria=excluded.acceptance_criteria,
      payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(id, project.id, role?.id || null, compactText(input.title, 300), compactText(input.goal, 5000), input.status || "pending",
        compactText(input.scope, 2000), JSON.stringify(uniqueStrings(input.acceptance_criteria)), JSON.stringify(input.payload ?? {}), this.projectEpoch(project), time, time);
    if (input.depends_on !== undefined) {
      this.db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
      const insert = this.db.prepare("INSERT INTO task_dependencies(task_id,depends_on) VALUES(?,?)");
      for (const dependency of uniqueStrings(input.depends_on)) insert.run(id, dependency);
    }
    return this.db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(id, project.id) as Row;
  }

  taskGraph(project: ProjectContext): Row[] {
    this.ensureProject(project);
    return this.db.prepare(`SELECT t.*,r.role_key owner_role,
      coalesce((SELECT json_group_array(depends_on) FROM task_dependencies d WHERE d.task_id=t.id),'[]') dependencies
      FROM tasks t LEFT JOIN roles r ON r.id=t.owner_role_id WHERE t.project_id=? ORDER BY t.created_at`).all(project.id) as Row[];
  }

  sendMessage(project: ProjectContext, input: SendMessageInput): Row {
    const from = this.getRole(project, input.from_role); const to = this.getRole(project, input.to_role);
    if (!from || !to) throw new Error("UNKNOWN_MESSAGE_ROLE");
    if ((from.role_key === "liaison" || to.role_key === "liaison") && from.role_key !== "coordinator" && to.role_key !== "coordinator") {
      throw new Error("LIAISON_ROUTE_REQUIRES_COORDINATOR");
    }
    this.assertCurrent(from, input.from_generation);
    if (input.architecture_epoch !== this.projectEpoch(project)) throw new Error("STALE_ARCHITECTURE_EPOCH");
    if (input.task_id) {
      const task = this.db.prepare("SELECT id FROM tasks WHERE id=? AND project_id=?").get(input.task_id, project.id) as Row | undefined;
      if (!task) throw new Error("ROLE_TASK_NOT_FOUND: task_id must reference a Role Runtime task; put a Project Memory task id in payload.project_memory_task_id instead.");
    }
    const id = input.message_id || newId("msg"); const time = nowIso();
    this.db.prepare(`INSERT INTO messages(id,project_id,type,from_role_id,to_role_id,from_generation,task_id,scope,architecture_epoch,payload,evidence_refs,reply_to,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(id, project.id, input.type, from.id, to.id, input.from_generation, input.task_id || null, compactText(input.scope, 2000),
        input.architecture_epoch, JSON.stringify(input.payload), JSON.stringify(uniqueStrings(input.evidence_refs)), input.reply_to || null, "pending", time);
    const row = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id WHERE m.id=?`).get(id) as Row;
    const conflicts = row.type !== input.type || row.from_role !== from.role_key || row.to_role !== to.role_key
      || Number(row.from_generation) !== input.from_generation || Number(row.architecture_epoch) !== input.architecture_epoch
      || String(row.task_id || "") !== String(input.task_id || "") || String(row.scope || "") !== compactText(input.scope, 2000)
      || String(row.reply_to || "") !== String(input.reply_to || "")
      || stableJson(parseJson(row.payload, null)) !== stableJson(input.payload)
      || stableJson(parseJson(row.evidence_refs, [])) !== stableJson(uniqueStrings(input.evidence_refs));
    if (conflicts) throw new Error("MESSAGE_ID_CONFLICT");
    return row;
  }

  inbox(project: ProjectContext, roleKey: string, includeAcknowledged = false): Row[] {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const statuses = includeAcknowledged ? "('pending','delivered','acknowledged')" : "('pending','delivered')";
    const rows = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id
      WHERE m.to_role_id=? AND m.status IN ${statuses} ORDER BY m.created_at LIMIT 100`).all(role.id) as Row[];
    const time = nowIso();
    this.db.prepare("UPDATE messages SET status='delivered',delivered_at=coalesce(delivered_at,?) WHERE to_role_id=? AND status='pending'").run(time, role.id);
    return rows.map((row) => ({ ...row, payload: parseJson(row.payload, {}), evidence_refs: parseJson(row.evidence_refs, []) }));
  }

  acknowledgeMessage(project: ProjectContext, roleKey: string, messageId: string): Row {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    this.db.prepare("UPDATE messages SET status='acknowledged',acknowledged_at=? WHERE id=? AND to_role_id=?")
      .run(nowIso(), messageId, role.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND to_role_id=?").get(messageId, role.id) as Row | undefined;
    if (!row) throw new Error("MESSAGE_NOT_FOUND"); return row;
  }

  claimMessageWake(project: ProjectContext, messageId: string): Row | null {
    this.ensureProject(project); const time = nowIso();
    const claimed = this.db.prepare(`UPDATE messages SET wake_status='running',wake_error=NULL,wake_started_at=?,wake_completed_at=NULL
      WHERE id=? AND project_id=? AND wake_status IN ('idle','failed')`).run(time, messageId, project.id);
    if (Number(claimed.changes) === 0) return null;
    return this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project.id) as Row;
  }

  finishMessageWake(project: ProjectContext, messageId: string): Row {
    this.db.prepare("UPDATE messages SET wake_status='completed',wake_error=NULL,wake_completed_at=? WHERE id=? AND project_id=?")
      .run(nowIso(), messageId, project.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project.id) as Row | undefined;
    if (!row) throw new Error("MESSAGE_NOT_FOUND"); return row;
  }

  failMessageWake(project: ProjectContext, messageId: string, error: string): Row {
    this.db.prepare("UPDATE messages SET wake_status='failed',wake_error=?,wake_completed_at=? WHERE id=? AND project_id=?")
      .run(compactText(error, 4000), nowIso(), messageId, project.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project.id) as Row | undefined;
    if (!row) throw new Error("MESSAGE_NOT_FOUND"); return row;
  }

  message(project: ProjectContext, messageId: string): Row | null {
    const row = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id WHERE m.id=? AND m.project_id=?`)
      .get(messageId, project.id) as Row | undefined;
    return row ? { ...row, payload: parseJson(row.payload, {}), evidence_refs: parseJson(row.evidence_refs, []) } : null;
  }

  resetProject(project: ProjectContext): Record<string, unknown> {
    const existing = this.db.prepare("SELECT id,root,name FROM projects WHERE id=?").get(project.id) as Row | undefined;
    if (!existing) return { project_id: project.id, root: project.root, deleted: false, counts: {} };
    const counts = {
      roles: Number((this.db.prepare("SELECT count(*) n FROM roles WHERE project_id=?").get(project.id) as Row).n),
      generations: Number((this.db.prepare("SELECT count(*) n FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE r.project_id=?").get(project.id) as Row).n),
      tasks: Number((this.db.prepare("SELECT count(*) n FROM tasks WHERE project_id=?").get(project.id) as Row).n),
      messages: Number((this.db.prepare("SELECT count(*) n FROM messages WHERE project_id=?").get(project.id) as Row).n),
      events: Number((this.db.prepare("SELECT count(*) n FROM events WHERE project_id=?").get(project.id) as Row).n)
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM events WHERE project_id=?").run(project.id);
      this.db.prepare("DELETE FROM messages WHERE project_id=?").run(project.id);
      this.db.prepare("DELETE FROM change_envelopes WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)").run(project.id);
      this.db.prepare("DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) OR depends_on IN (SELECT id FROM tasks WHERE project_id=?)").run(project.id, project.id);
      this.db.prepare("DELETE FROM tasks WHERE project_id=?").run(project.id);
      this.db.prepare("DELETE FROM rotations WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project.id);
      this.db.prepare("DELETE FROM role_leases WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project.id);
      this.db.prepare("DELETE FROM role_facts WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project.id);
      this.db.prepare("DELETE FROM role_generations WHERE role_id IN (SELECT id FROM roles WHERE project_id=?)").run(project.id);
      this.db.prepare("DELETE FROM roles WHERE project_id=?").run(project.id);
      this.db.prepare("DELETE FROM projects WHERE id=?").run(project.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { project_id: project.id, root: existing.root, deleted: true, counts };
  }

  advanceArchitecture(project: ProjectContext, reason: string): Row {
    this.ensureProject(project); const time = nowIso();
    this.db.prepare("UPDATE projects SET architecture_epoch=architecture_epoch+1,updated_at=? WHERE id=?").run(time, project.id);
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(project.id) as Row;
    this.recordEvent(project, { event_type: "architecture_advanced", event_key: `architecture:${row.architecture_epoch}`, payload: { reason } });
    return row;
  }

  createEnvelope(project: ProjectContext, input: { task_id: string; owner_role: string; intent: string; allowed_scope: string[]; expected_symbols?: string[]; constraints?: string[]; non_goals?: string[]; tests?: string[] }): Row {
    const role = this.getRole(project, input.owner_role); if (!role) throw new Error(`Unknown role: ${input.owner_role}`);
    const task = this.db.prepare("SELECT id FROM tasks WHERE id=? AND project_id=?").get(input.task_id, project.id) as Row | undefined;
    if (!task) throw new Error("TASK_NOT_FOUND"); const id = newId("env"); const time = nowIso();
    this.db.prepare(`INSERT INTO change_envelopes(id,task_id,owner_role_id,architecture_epoch,intent,allowed_scope,expected_symbols,constraints,non_goals,tests,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.task_id, role.id, this.projectEpoch(project), compactText(input.intent, 5000),
        JSON.stringify(uniqueStrings(input.allowed_scope)), JSON.stringify(uniqueStrings(input.expected_symbols)), JSON.stringify(uniqueStrings(input.constraints)),
        JSON.stringify(uniqueStrings(input.non_goals)), JSON.stringify(uniqueStrings(input.tests)), time, time);
    return this.db.prepare("SELECT * FROM change_envelopes WHERE id=?").get(id) as Row;
  }

  checkEnvelope(project: ProjectContext, envelopeId: string, actualPaths: string[]): Row {
    const row = this.db.prepare(`SELECT e.* FROM change_envelopes e JOIN tasks t ON t.id=e.task_id WHERE e.id=? AND t.project_id=?`)
      .get(envelopeId, project.id) as Row | undefined;
    if (!row) throw new Error("ENVELOPE_NOT_FOUND");
    if (Number(row.architecture_epoch) !== this.projectEpoch(project)) throw new Error("STALE_ARCHITECTURE_EPOCH");
    const allowed = parseJson<string[]>(row.allowed_scope, []); const paths = uniqueStrings(actualPaths, 1000);
    const violations = paths.filter((path) => !matchesAny(path.replace(/\\/g, "/"), allowed));
    const status = violations.length ? "violated" : "passed";
    this.db.prepare("UPDATE change_envelopes SET actual_paths=?,status=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(paths), status, nowIso(), envelopeId);
    return { ...this.db.prepare("SELECT * FROM change_envelopes WHERE id=?").get(envelopeId) as Row, violations };
  }

  createRotation(project: ProjectContext, roleKey: string, reason: string): Row {
    const role = this.getRole(project, roleKey); if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const old = this.activeGeneration(project, roleKey); const id = newId("rotation"); const time = nowIso();
    const checkpoint = this.context(project, roleKey);
    this.db.prepare(`INSERT INTO rotations(id,role_id,old_generation_id,state,reason,checkpoint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, role.id, old?.id || null, "ROTATION_PENDING", compactText(reason, 2000), JSON.stringify(checkpoint), time, time);
    return this.db.prepare("SELECT * FROM rotations WHERE id=?").get(id) as Row;
  }

  updateRotation(rotationId: string, state: RotationState, input: { candidateId?: string; error?: string } = {}): Row {
    const time = nowIso();
    this.db.prepare(`UPDATE rotations SET state=?,candidate_generation_id=coalesce(?,candidate_generation_id),error=coalesce(?,error),
      updated_at=?,completed_at=CASE WHEN ? IN ('COMPLETED','FAILED') THEN ? ELSE completed_at END WHERE id=?`)
      .run(state, input.candidateId || null, input.error || null, time, state, time, rotationId);
    const row = this.db.prepare("SELECT * FROM rotations WHERE id=?").get(rotationId) as Row | undefined;
    if (!row) throw new Error("ROTATION_NOT_FOUND"); return row;
  }

  validateBootstrap(project: ProjectContext, roleKey: string, response: BootstrapResponse): { ok: boolean; errors: string[] } {
    const context = this.context(project, roleKey); const role = context.role as RoleRecord;
    const errors: string[] = [];
    if (response.role_id !== role.role_key) errors.push("role_id mismatch");
    if (response.mission !== role.mission) errors.push("mission mismatch");
    if (JSON.stringify(response.owned_domains) !== JSON.stringify(role.owned_domains)) errors.push("owned_domains mismatch");
    if (response.architecture_epoch !== Number((context.project as Row).architecture_epoch)) errors.push("architecture_epoch mismatch");
    const invariants = (context.facts as Row[]).filter((fact) => fact.kind === "invariant").map((fact) => String(fact.content));
    if (JSON.stringify(response.critical_invariants) !== JSON.stringify(invariants)) errors.push("critical_invariants mismatch");
    return { ok: errors.length === 0, errors };
  }

  recordEvent(project: ProjectContext, input: { event_type: string; event_key?: string; role_id?: string; generation_id?: string; payload?: unknown }): boolean {
    this.ensureProject(project); const result = this.db.prepare(`INSERT INTO events(id,project_id,role_id,generation_id,event_key,event_type,payload,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).run(newId("evt"), project.id, input.role_id || null, input.generation_id || null,
        input.event_key || null, input.event_type, JSON.stringify(input.payload ?? null), nowIso());
    return Number(result.changes) > 0;
  }

  observeGeneration(project: ProjectContext, threadId: string, input: { event: string; eventKey?: string; tokenUsage?: number }): GenerationRecord | null {
    const binding = this.getGenerationByThread(project, threadId); if (!binding) return null;
    const inserted = this.recordEvent(project, { event_type: input.event, ...(input.eventKey ? { event_key: input.eventKey } : {}), role_id: binding.role.id, generation_id: binding.generation.id });
    if (!inserted) return this.getGenerationByThread(project, threadId)!.generation;
    const time = nowIso();
    if (input.event === "turn") this.db.prepare("UPDATE role_generations SET turn_count=turn_count+1,last_seen_at=? WHERE id=?").run(time, binding.generation.id);
    else if (input.event === "compact") this.db.prepare(`UPDATE role_generations SET compact_count=compact_count+1,
      health=CASE WHEN compact_count+1>=2 THEN 'rotation_required' ELSE 'aging' END,last_seen_at=? WHERE id=? AND status='active'`).run(time, binding.generation.id);
    else this.db.prepare("UPDATE role_generations SET last_seen_at=? WHERE id=?").run(time, binding.generation.id);
    if (input.tokenUsage !== undefined) this.db.prepare("UPDATE role_generations SET token_usage=max(token_usage,?) WHERE id=?").run(input.tokenUsage, binding.generation.id);
    return this.getGenerationByThread(project, threadId)!.generation;
  }

  context(project: ProjectContext, roleKey: string): Record<string, unknown> {
    const projectRow = this.ensureProject(project); const role = this.getRole(project, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const active = this.activeGeneration(project, roleKey); const facts = this.listFacts(project, roleKey);
    const tasks = this.db.prepare("SELECT * FROM tasks WHERE owner_role_id=? AND status NOT IN ('completed','cancelled') ORDER BY updated_at DESC").all(role.id) as Row[];
    const messages = this.db.prepare("SELECT count(*) count FROM messages WHERE to_role_id=? AND status IN ('pending','delivered')").get(role.id) as Row;
    return {
      project: { id: project.id, root: project.root, name: project.name, constitution: projectRow.constitution, architecture_epoch: Number(projectRow.architecture_epoch) },
      role, active_generation: active, facts, tasks, pending_messages: Number(messages.count),
      context_hash: stableHash({ project: projectRow.constitution, epoch: projectRow.architecture_epoch, role, facts, tasks })
    };
  }

  roleAnchor(project: ProjectContext, roleKey: string, generationOverride?: GenerationRecord): string {
    const context = this.context(project, roleKey); const role = context.role as RoleRecord;
    const generation = generationOverride ?? (context.active_generation as GenerationRecord | null);
    const facts = context.facts as Row[]; const invariants = facts.filter((fact) => fact.kind === "invariant").slice(0, 8);
    const tasks = context.tasks as Row[];
    const interactionContract = role.role_key === "liaison"
      ? "Interaction contract: you are the user's sole conversational entry point. Clarify intent, send structured requests and decisions to role://coordinator, and translate its questions, progress, blockers, and verified results for the user. Do not perform internal coordination or implementation yourself."
      : role.role_key === "coordinator"
        ? "Interaction contract: receive user intent from role://liaison and return questions, progress, blockers, and results through role://liaison; do not require the user to contact internal roles."
        : "Interaction contract: communicate user-facing questions and results through role://coordinator, which routes them through role://liaison.";
    return [
      "[Codex Role Runtime]",
      `Role: ${role.name} (role://${role.role_key})`,
      `Generation: ${generation?.generation_number ?? "unbound"}${generation ? ` (${generation.status})` : ""}; Architecture epoch: ${(context.project as Row).architecture_epoch}`,
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

  status(project: ProjectContext): Record<string, unknown> {
    const projectRow = this.ensureProject(project);
    const counts = this.db.prepare(`SELECT
      (SELECT count(*) FROM roles WHERE project_id=?) roles,
      (SELECT count(*) FROM role_generations g JOIN roles r ON r.id=g.role_id WHERE r.project_id=? AND g.status='active') active_generations,
      (SELECT count(*) FROM messages WHERE project_id=? AND status IN ('pending','delivered')) open_messages,
      (SELECT count(*) FROM tasks WHERE project_id=? AND status NOT IN ('completed','cancelled')) open_tasks`)
      .get(project.id, project.id, project.id, project.id) as Row;
    const rotations = this.db.prepare(`SELECT x.*,r.role_key FROM rotations x JOIN roles r ON r.id=x.role_id
      WHERE r.project_id=? AND x.state NOT IN ('COMPLETED','FAILED') ORDER BY x.created_at`).all(project.id) as Row[];
    return { project: { ...project, architecture_epoch: Number(projectRow.architecture_epoch), constitution: projectRow.constitution }, roles: this.listRoles(project), counts, open_rotations: rotations, database_path: this.databasePath };
  }
}
