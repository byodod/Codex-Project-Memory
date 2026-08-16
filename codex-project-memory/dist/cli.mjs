// src/storage.ts
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync as mkdirSync2, rmSync } from "node:fs";

// src/util.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
var newId = (prefix) => `${prefix}_${randomUUID()}`;
var sha256 = (value) => createHash("sha256").update(value).digest("hex");
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
function compactText(value, max = 2e4) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const normalized = text.replace(/\r\n/g, "\n").replace(/[\t ]+\n/g, "\n").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}
\u2026[truncated]`;
}
function safeJsonParse(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function uniqueStrings(values, maxItems = 50) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => compactText(v, 1e3)).filter(Boolean))].slice(0, maxItems);
}
function ftsQuery(query) {
  const tokens = query.match(/[\p{L}\p{N}_./\\:-]+/gu) ?? [];
  return [...new Set(tokens)].slice(0, 20).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
}
function atomicWriteSync(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}
function markdownEscape(value) {
  return value.replace(/[<>]/g, (char) => char === "<" ? "&lt;" : "&gt;");
}

// src/storage.ts
function dataRoot(explicit) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return explicit || process.env.CODEX_PROJECT_MEMORY_HOME || process.env.PLUGIN_DATA || join(codexHome, "plugin-data", "codex-project-memory");
}
function taskFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    status: row.status,
    acceptance_criteria: safeJsonParse(row.acceptance_criteria, []),
    completed_items: safeJsonParse(row.completed_items, []),
    next_steps: safeJsonParse(row.next_steps, []),
    blockers: safeJsonParse(row.blockers, []),
    gate_enabled: Boolean(row.gate_enabled)
  };
}
function memoryFromRow(row) {
  return {
    ...row,
    kind: row.kind,
    authority: row.authority,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    recall_count: Number(row.recall_count),
    tags: safeJsonParse(row.tags, []),
    score: row.score === void 0 ? void 0 : Number(row.score),
    rank: row.rank === void 0 ? void 0 : Number(row.rank)
  };
}
var MemoryStore = class {
  root;
  databasePath;
  db;
  constructor(root) {
    this.root = dataRoot(root);
    mkdirSync2(this.root, { recursive: true });
    this.databasePath = join(this.root, "project-memory.sqlite3");
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }
  close() {
    this.db.close();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        name TEXT NOT NULL,
        remote TEXT,
        git_common_dir TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','completed')),
        branch TEXT,
        base_revision TEXT,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        completed_items TEXT NOT NULL DEFAULT '[]',
        next_steps TEXT NOT NULL DEFAULT '[]',
        blockers TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        gate_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_branch ON tasks(project_id, branch, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        authority TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','archived')),
        source_note TEXT,
        file_path TEXT,
        symbol TEXT,
        error_signature TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT REFERENCES memories(id),
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, status, importance DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_task ON memories(task_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_path ON memories(project_id, file_path, status);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        summary,
        content,
        file_path,
        symbol,
        error_signature,
        tags,
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id,summary,content,file_path,symbol,error_signature,tags)
        VALUES(new.id,new.summary,new.content,coalesce(new.file_path,''),coalesce(new.symbol,''),coalesce(new.error_signature,''),new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE id=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        DELETE FROM memories_fts WHERE id=old.id;
        INSERT INTO memories_fts(id,summary,content,file_path,symbol,error_signature,tags)
        VALUES(new.id,new.summary,new.content,coalesce(new.file_path,''),coalesce(new.symbol,''),coalesce(new.error_signature,''),new.tags);
      END;

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        session_id TEXT,
        turn_id TEXT,
        tool_use_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT,
        exit_code INTEGER,
        file_path TEXT,
        symbol TEXT,
        error_signature TEXT,
        authority TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tool_unique ON events(tool_use_id, event_type) WHERE tool_use_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        criterion TEXT,
        command TEXT,
        status TEXT NOT NULL CHECK(status IN ('passed','failed','skipped')),
        evidence TEXT NOT NULL,
        revision TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        session_id TEXT,
        turn_id TEXT,
        trigger TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id, created_at DESC);
    `);
  }
  ensureProject(project2) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO projects(id,root,name,remote,git_common_dir,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET root=excluded.root,name=excluded.name,remote=excluded.remote,
        git_common_dir=excluded.git_common_dir,updated_at=excluded.updated_at
    `).run(project2.id, project2.root, project2.name, project2.remote, project2.gitCommonDir, timestamp, timestamp);
  }
  getActiveTask(project2) {
    this.ensureProject(project2);
    let row;
    if (project2.branch) {
      row = this.db.prepare(`SELECT * FROM tasks WHERE project_id=? AND status='active' AND branch=? ORDER BY updated_at DESC LIMIT 1`).get(project2.id, project2.branch);
    }
    row ||= this.db.prepare(`SELECT * FROM tasks WHERE project_id=? AND status='active' ORDER BY updated_at DESC LIMIT 1`).get(project2.id);
    return taskFromRow(row);
  }
  getTask(project2, taskId) {
    this.ensureProject(project2);
    if (!taskId) return this.getActiveTask(project2);
    return taskFromRow(this.db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(taskId, project2.id));
  }
  upsertTask(project2, input) {
    this.ensureProject(project2);
    const existing = input.task_id ? this.getTask(project2, input.task_id) : this.getActiveTask(project2);
    const timestamp = nowIso();
    const task = existing ?? {
      id: input.task_id || newId("task"),
      project_id: project2.id,
      title: compactText(input.title || input.goal || "Active project task", 300),
      goal: compactText(input.goal || input.title || "Maintain current project task", 4e3),
      status: "active",
      branch: project2.branch,
      base_revision: project2.revision,
      acceptance_criteria: [],
      completed_items: [],
      next_steps: [],
      blockers: [],
      notes: null,
      gate_enabled: true,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null
    };
    task.title = compactText(input.title ?? task.title, 300);
    task.goal = compactText(input.goal ?? task.goal, 4e3);
    task.status = input.status ?? task.status;
    task.acceptance_criteria = input.acceptance_criteria === void 0 ? task.acceptance_criteria : uniqueStrings(input.acceptance_criteria);
    task.completed_items = input.completed_items === void 0 ? task.completed_items : uniqueStrings(input.completed_items);
    task.next_steps = input.next_steps === void 0 ? task.next_steps : uniqueStrings(input.next_steps);
    task.blockers = input.blockers === void 0 ? task.blockers : uniqueStrings(input.blockers);
    task.notes = input.notes === void 0 ? task.notes : compactText(input.notes, 4e3) || null;
    task.gate_enabled = input.gate_enabled ?? task.gate_enabled;
    task.updated_at = timestamp;
    task.completed_at = task.status === "completed" ? task.completed_at ?? timestamp : null;
    this.db.prepare(`
      INSERT INTO tasks(id,project_id,title,goal,status,branch,base_revision,acceptance_criteria,completed_items,next_steps,blockers,notes,gate_enabled,created_at,updated_at,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,goal=excluded.goal,status=excluded.status,
        acceptance_criteria=excluded.acceptance_criteria,completed_items=excluded.completed_items,next_steps=excluded.next_steps,
        blockers=excluded.blockers,notes=excluded.notes,gate_enabled=excluded.gate_enabled,updated_at=excluded.updated_at,
        completed_at=excluded.completed_at
    `).run(
      task.id,
      task.project_id,
      task.title,
      task.goal,
      task.status,
      task.branch,
      task.base_revision,
      JSON.stringify(task.acceptance_criteria),
      JSON.stringify(task.completed_items),
      JSON.stringify(task.next_steps),
      JSON.stringify(task.blockers),
      task.notes,
      task.gate_enabled ? 1 : 0,
      task.created_at,
      task.updated_at,
      task.completed_at
    );
    this.exportProject(project2);
    return task;
  }
  completionIssues(task) {
    const completed = new Set(task.completed_items);
    const missing = task.acceptance_criteria.filter((criterion) => !completed.has(criterion));
    const issues = [];
    if (missing.length) issues.push(`\u672A\u6EE1\u8DB3\u9A8C\u6536\u6807\u51C6\uFF1A${missing.join("\uFF1B")}`);
    if (task.blockers.length) issues.push(`\u4ECD\u6709\u963B\u585E\uFF1A${task.blockers.join("\uFF1B")}`);
    if (task.next_steps.length) issues.push(`\u4ECD\u6709\u4E0B\u4E00\u6B65\uFF1A${task.next_steps.join("\uFF1B")}`);
    return issues;
  }
  completeTask(project2, taskId, summary) {
    const task = this.getTask(project2, taskId);
    if (!task) throw new Error("No matching task exists.");
    const issues = this.completionIssues(task);
    if (issues.length) throw new Error(`Task cannot be completed. ${issues.join(" ")}`);
    const completed = this.upsertTask(project2, { task_id: task.id, status: "completed", notes: summary ?? task.notes });
    this.checkpoint(project2, { taskId: completed.id, trigger: "complete" });
    return completed;
  }
  storeMemory(project2, input) {
    this.ensureProject(project2);
    const timestamp = nowIso();
    const content = compactText(input.content, 2e4);
    if (!content) throw new Error("Memory content must not be empty.");
    const summary = compactText(input.summary || content.split("\n", 1)[0], 300);
    const record = {
      id: newId("mem"),
      project_id: project2.id,
      task_id: input.task_id ?? this.getActiveTask(project2)?.id ?? null,
      kind: input.kind,
      summary,
      content,
      authority: input.authority,
      confidence: clamp(input.confidence ?? 0.8),
      importance: clamp(input.importance ?? 0.5),
      status: "active",
      source_note: compactText(input.source_note, 1e3) || null,
      file_path: compactText(input.file_path, 1e3) || null,
      symbol: compactText(input.symbol, 500) || null,
      error_signature: compactText(input.error_signature, 1e3) || null,
      tags: uniqueStrings(input.tags, 20),
      superseded_by: null,
      recall_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
      verified_at: input.verified ? timestamp : null,
      expires_at: input.expires_at ?? null
    };
    this.db.prepare(`
      INSERT INTO memories(id,project_id,task_id,kind,summary,content,authority,confidence,importance,status,source_note,file_path,symbol,error_signature,tags,superseded_by,recall_count,created_at,updated_at,verified_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      record.id,
      record.project_id,
      record.task_id,
      record.kind,
      record.summary,
      record.content,
      record.authority,
      record.confidence,
      record.importance,
      record.status,
      record.source_note,
      record.file_path,
      record.symbol,
      record.error_signature,
      JSON.stringify(record.tags),
      null,
      0,
      timestamp,
      timestamp,
      record.verified_at,
      record.expires_at
    );
    this.exportProject(project2);
    return record;
  }
  getMemory(project2, id) {
    this.ensureProject(project2);
    const row = this.db.prepare("SELECT * FROM memories WHERE id=? AND project_id=?").get(id, project2.id);
    return row ? memoryFromRow(row) : null;
  }
  search(project2, query, options = {}) {
    this.ensureProject(project2);
    const limit = Math.max(1, Math.min(options.limit ?? 8, 30));
    const params = [project2.id];
    const where = ["m.project_id=?"];
    if (!options.includeSuperseded) where.push("m.status='active'");
    if (options.taskId) {
      where.push("(m.task_id=? OR m.task_id IS NULL)");
      params.push(options.taskId);
    }
    if (options.kinds?.length) {
      where.push(`m.kind IN (${options.kinds.map(() => "?").join(",")})`);
      params.push(...options.kinds);
    }
    const match = ftsQuery(query);
    let rows;
    if (match) {
      try {
        rows = this.db.prepare(`
          SELECT m.*, bm25(memories_fts) AS rank
          FROM memories_fts JOIN memories m ON m.id=memories_fts.id
          WHERE memories_fts MATCH ? AND ${where.join(" AND ")}
          ORDER BY rank ASC, m.importance DESC, m.updated_at DESC LIMIT ?
        `).all(match, ...params, limit * 3);
      } catch {
        rows = [];
      }
    } else {
      rows = this.db.prepare(`SELECT m.* FROM memories m WHERE ${where.join(" AND ")} ORDER BY m.importance DESC,m.updated_at DESC LIMIT ?`).all(...params, limit * 3);
    }
    const needle = query.toLowerCase();
    const now = Date.now();
    const scored = rows.map(memoryFromRow).filter((memory) => !memory.expires_at || Date.parse(memory.expires_at) > now).map((memory) => {
      let score = memory.importance * 2 + memory.confidence;
      if (needle && memory.symbol?.toLowerCase() === needle) score += 8;
      if (needle && memory.file_path?.toLowerCase().includes(needle)) score += 5;
      if (needle && memory.error_signature?.toLowerCase().includes(needle)) score += 6;
      if (options.taskId && memory.task_id === options.taskId) score += 2;
      if (["user_decision", "project_authority"].includes(memory.authority)) score += 1.5;
      if (memory.kind === "failure") score += 0.5;
      if (memory.rank !== void 0 && memory.rank < 0) score += Math.min(8, -memory.rank);
      return { ...memory, score };
    }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
    if (scored.length) {
      const timestamp = nowIso();
      const update = this.db.prepare("UPDATE memories SET recall_count=recall_count+1,last_recalled_at=? WHERE id=?");
      for (const memory of scored) update.run(timestamp, memory.id);
      return scored.map((memory) => ({ ...memory, recall_count: memory.recall_count + 1, last_recalled_at: timestamp }));
    }
    return scored;
  }
  supersede(project2, oldId, replacement) {
    const old = this.getMemory(project2, oldId);
    if (!old || old.status !== "active") throw new Error("Active memory to supersede was not found.");
    const next = this.storeMemory(project2, { ...replacement, task_id: replacement.task_id ?? old.task_id });
    this.db.prepare("UPDATE memories SET status='superseded',superseded_by=?,updated_at=? WHERE id=?").run(next.id, nowIso(), old.id);
    this.exportProject(project2);
    return { old: { ...old, status: "superseded", superseded_by: next.id }, replacement: next };
  }
  archiveMemory(project2, id) {
    const memory = this.getMemory(project2, id);
    if (!memory) throw new Error("Memory was not found.");
    this.db.prepare("UPDATE memories SET status='archived',updated_at=? WHERE id=? AND project_id=?").run(nowIso(), id, project2.id);
    this.exportProject(project2);
    return { ...memory, status: "archived" };
  }
  recordEvent(project2, event) {
    this.ensureProject(project2);
    const id = newId("evt");
    try {
      this.db.prepare(`
        INSERT INTO events(id,project_id,task_id,session_id,turn_id,tool_use_id,event_type,payload,exit_code,file_path,symbol,error_signature,authority,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        project2.id,
        event.taskId ?? this.getActiveTask(project2)?.id ?? null,
        event.sessionId ?? null,
        event.turnId ?? null,
        event.toolUseId ?? null,
        event.eventType,
        compactText(event.payload, 16e3) || null,
        event.exitCode ?? null,
        event.filePath ?? null,
        event.symbol ?? null,
        event.errorSignature ?? null,
        event.authority ?? "tool_observation",
        nowIso()
      );
    } catch (error) {
      if (!String(error).includes("UNIQUE constraint failed")) throw error;
    }
    return id;
  }
  recordVerification(project2, input) {
    this.ensureProject(project2);
    const task = this.getTask(project2, input.taskId);
    if (!task) throw new Error("An active or explicit task is required for verification evidence.");
    const row = {
      id: newId("verify"),
      project_id: project2.id,
      task_id: task.id,
      criterion: compactText(input.criterion, 1e3) || null,
      command: compactText(input.command, 2e3) || null,
      status: input.status,
      evidence: compactText(input.evidence, 8e3),
      revision: project2.revision,
      created_at: nowIso()
    };
    this.db.prepare("INSERT INTO verifications(id,project_id,task_id,criterion,command,status,evidence,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(row.id, row.project_id, row.task_id, row.criterion, row.command, row.status, row.evidence, row.revision, row.created_at);
    return row;
  }
  listVerifications(project2, taskId) {
    return this.db.prepare("SELECT * FROM verifications WHERE project_id=? AND task_id=? ORDER BY created_at DESC LIMIT 50").all(project2.id, taskId);
  }
  checkpoint(project2, input) {
    this.ensureProject(project2);
    const task = this.getTask(project2, input.taskId);
    const recentEvents = this.db.prepare("SELECT id,event_type,exit_code,error_signature,created_at FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT 20").all(project2.id);
    const snapshot = {
      schema_version: 1,
      project: { id: project2.id, root: project2.root, branch: project2.branch, revision: project2.revision },
      task,
      recent_events: recentEvents,
      captured_at: nowIso()
    };
    const row = {
      id: newId("checkpoint"),
      project_id: project2.id,
      task_id: task?.id ?? null,
      session_id: input.sessionId ?? null,
      turn_id: input.turnId ?? null,
      trigger: compactText(input.trigger, 100),
      snapshot: JSON.stringify(snapshot),
      created_at: nowIso()
    };
    this.db.prepare("INSERT INTO checkpoints(id,project_id,task_id,session_id,turn_id,trigger,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)").run(row.id, row.project_id, row.task_id, row.session_id, row.turn_id, row.trigger, row.snapshot, row.created_at);
    this.exportProject(project2);
    return { ...row, snapshot };
  }
  status(project2) {
    this.ensureProject(project2);
    const counts = this.db.prepare(`
      SELECT
        (SELECT count(*) FROM memories WHERE project_id=? AND status='active') active_memories,
        (SELECT count(*) FROM events WHERE project_id=?) events,
        (SELECT count(*) FROM tasks WHERE project_id=?) tasks,
        (SELECT count(*) FROM checkpoints WHERE project_id=?) checkpoints
    `).get(project2.id, project2.id, project2.id, project2.id);
    return {
      project: project2,
      active_task: this.getActiveTask(project2),
      counts,
      database_path: this.databasePath,
      export_directory: join(this.root, "projects", project2.id)
    };
  }
  consolidate(project2, apply = false) {
    const rows = this.db.prepare("SELECT * FROM memories WHERE project_id=? AND status='active' ORDER BY created_at ASC").all(project2.id);
    const seen = /* @__PURE__ */ new Map();
    const duplicates = [];
    for (const row of rows) {
      const key = `${String(row.kind)}|${String(row.content).trim().toLowerCase().replace(/\s+/g, " ")}`;
      const keep = seen.get(key);
      if (keep) duplicates.push({ keep, archive: String(row.id) });
      else seen.set(key, String(row.id));
    }
    if (apply) {
      const update = this.db.prepare("UPDATE memories SET status='archived',updated_at=? WHERE id=?");
      for (const duplicate of duplicates) update.run(nowIso(), duplicate.archive);
      this.exportProject(project2);
    }
    return { apply, exact_duplicates: duplicates, changed: apply ? duplicates.length : 0 };
  }
  resetProject(project2) {
    const existing = this.db.prepare("SELECT id,root,name FROM projects WHERE id=?").get(project2.id);
    if (!existing) return { project_id: project2.id, root: project2.root, deleted: false, counts: {}, export_removed: false };
    const counts = {
      tasks: Number(this.db.prepare("SELECT count(*) n FROM tasks WHERE project_id=?").get(project2.id).n),
      memories: Number(this.db.prepare("SELECT count(*) n FROM memories WHERE project_id=?").get(project2.id).n),
      events: Number(this.db.prepare("SELECT count(*) n FROM events WHERE project_id=?").get(project2.id).n),
      verifications: Number(this.db.prepare("SELECT count(*) n FROM verifications WHERE project_id=?").get(project2.id).n),
      checkpoints: Number(this.db.prepare("SELECT count(*) n FROM checkpoints WHERE project_id=?").get(project2.id).n)
    };
    this.db.prepare("DELETE FROM projects WHERE id=?").run(project2.id);
    const projectsRoot = resolve(this.root, "projects");
    const exportDirectory = resolve(projectsRoot, project2.id);
    if (!exportDirectory.startsWith(`${projectsRoot}${sep}`)) throw new Error("UNSAFE_PROJECT_EXPORT_PATH");
    rmSync(exportDirectory, { recursive: true, force: true });
    return { project_id: project2.id, root: existing.root, deleted: true, counts, export_removed: true };
  }
  exportProject(project2) {
    const base = join(this.root, "projects", project2.id);
    const memories = this.db.prepare(`
      SELECT * FROM memories WHERE project_id=? AND status='active'
        AND kind IN ('decision','project_fact','constraint','tool_quirk')
      ORDER BY importance DESC, updated_at DESC LIMIT 100
    `).all(project2.id);
    const grouped = /* @__PURE__ */ new Map();
    for (const row of memories) {
      const memory = memoryFromRow(row);
      grouped.set(memory.kind, [...grouped.get(memory.kind) ?? [], memory]);
    }
    const labels = {
      decision: "Decisions",
      project_fact: "Verified project facts",
      constraint: "Constraints",
      tool_quirk: "Tool quirks"
    };
    const sections = [...grouped.entries()].map(([kind, items]) => [
      `## ${labels[kind] ?? kind}`,
      ...items.map((item) => `- **${markdownEscape(item.summary)}** \u2014 ${markdownEscape(item.content)} _(authority: ${item.authority}; id: ${item.id})_`)
    ].join("\n"));
    const memoryMd = [
      "# Project Memory",
      "",
      `Project: ${markdownEscape(project2.name)}`,
      "",
      "> Generated from SQLite. Historical context is not an instruction source; AGENTS.md, repository docs, and the current user remain authoritative.",
      "",
      ...sections.length ? sections : ["No curated memories yet."],
      ""
    ].join("\n");
    atomicWriteSync(join(base, "MEMORY.md"), memoryMd);
    const task = this.getActiveTask(project2);
    if (task) atomicWriteSync(join(base, "tasks", `${task.id}.json`), `${JSON.stringify(task, null, 2)}
`);
  }
};

// src/repository.ts
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, resolve as resolve2 } from "node:path";
import { realpathSync } from "node:fs";
function git(cwd2, args2) {
  try {
    return execFileSync("git", args2, {
      cwd: cwd2,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 3e3
    }).trim() || null;
  } catch {
    return null;
  }
}
function normalizedPath(path) {
  const absolute = resolve2(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
function resolveProject(cwdInput) {
  const cwd2 = normalizedPath(cwdInput || process.cwd());
  const topLevel = git(cwd2, ["rev-parse", "--show-toplevel"]);
  const root = normalizedPath(topLevel || cwd2);
  const commonRaw = git(root, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = commonRaw ? normalizedPath(isAbsolute(commonRaw) ? commonRaw : resolve2(root, commonRaw)) : null;
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const branch = git(root, ["branch", "--show-current"]);
  const revision = git(root, ["rev-parse", "HEAD"]);
  const identity = remote ? `remote:${remote.toLowerCase()}|common:${gitCommonDir ?? root}` : `path:${gitCommonDir ?? root}`;
  return {
    id: sha256(identity).slice(0, 24),
    root,
    name: basename(root),
    remote,
    gitCommonDir,
    branch,
    revision
  };
}

// ../codex-role-runtime/src/store.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync as mkdirSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// ../codex-role-runtime/src/util.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId2(prefix) {
  return `${prefix}_${randomUUID2()}`;
}
function stableId(value, length = 24) {
  return createHash2("sha256").update(value).digest("hex").slice(0, length);
}
function stableHash(value) {
  return createHash2("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function compactText2(value, max) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}
function uniqueStrings2(values, max = 100) {
  return [...new Set((values ?? []).map((value) => compactText2(value, 1e3)).filter(Boolean))].slice(0, max);
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

// ../codex-role-runtime/src/store.ts
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
    const codexHome = process.env.CODEX_HOME || join2(homedir2(), ".codex");
    this.root = root || process.env.CODEX_ROLE_RUNTIME_HOME || process.env.PLUGIN_DATA || join2(codexHome, "plugin-data", "codex-role-runtime");
    mkdirSync3(this.root, { recursive: true });
    this.databasePath = join2(this.root, "role-runtime.sqlite3");
    this.db = new DatabaseSync2(this.databasePath);
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
    const time = nowIso2();
    this.db.prepare(`INSERT INTO projects(id,root,name,remote,git_common_dir,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,name=excluded.name,remote=excluded.remote,
      git_common_dir=excluded.git_common_dir,updated_at=excluded.updated_at`).run(project2.id, project2.root, project2.name, project2.remote, project2.gitCommonDir, time, time);
    return this.db.prepare("SELECT * FROM projects WHERE id=?").get(project2.id);
  }
  configureProject(project2, constitution) {
    this.ensureProject(project2);
    if (constitution !== void 0) this.db.prepare("UPDATE projects SET constitution=?,updated_at=? WHERE id=?").run(compactText2(constitution, 12e3), nowIso2(), project2.id);
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
      deniedTools: uniqueStrings2(input.policy?.deniedTools ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).deniedTools : DEFAULT_POLICY.deniedTools)),
      allowedWriteGlobs: uniqueStrings2(input.policy?.allowedWriteGlobs ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).allowedWriteGlobs : [])),
      canDelegateTo: uniqueStrings2(input.policy?.canDelegateTo ?? (existing ? parseJson(existing.policy, DEFAULT_POLICY).canDelegateTo : []))
    };
    if (policy.mode === "workspace_write") policy.deniedTools = policy.deniedTools.filter((tool) => !["apply_patch", "Edit", "Write"].includes(tool));
    const time = nowIso2();
    const id = existing ? String(existing.id) : newId2("role");
    this.db.prepare(`INSERT INTO roles(id,project_id,role_key,name,kind,mission,owned_domains,excluded_domains,escalation_rules,policy,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,role_key) DO UPDATE SET name=excluded.name,kind=excluded.kind,
      mission=excluded.mission,owned_domains=excluded.owned_domains,excluded_domains=excluded.excluded_domains,
      escalation_rules=excluded.escalation_rules,policy=excluded.policy,updated_at=excluded.updated_at`).run(
      id,
      project2.id,
      key,
      compactText2(input.name || key, 200),
      input.kind || "owner",
      compactText2(input.mission, 4e3),
      JSON.stringify(uniqueStrings2(input.owned_domains)),
      JSON.stringify(uniqueStrings2(input.excluded_domains)),
      JSON.stringify(uniqueStrings2(input.escalation_rules)),
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
    const time = nowIso2();
    const id = newId2("gen");
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
    const time = nowIso2();
    const id = newId2("gen");
    this.db.prepare(`INSERT INTO role_generations(id,role_id,generation_number,thread_id,status,health,architecture_epoch,bootstrap_hash,started_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, role.id, number, threadId, "bootstrapping", "healthy", this.projectEpoch(project2), bootstrapHash || null, time, time);
    return generationFromRow(this.db.prepare("SELECT * FROM role_generations WHERE id=?").get(id));
  }
  activateCandidate(project2, roleKey, candidateId, reason) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const candidate = this.db.prepare("SELECT * FROM role_generations WHERE id=? AND role_id=?").get(candidateId, role.id);
    if (!candidate || candidate.status !== "bootstrapping") throw new Error("CANDIDATE_NOT_BOOTSTRAPPING");
    const time = nowIso2();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE role_generations SET status='retired',health='retired',retirement_reason=?,ended_at=? WHERE role_id=? AND status='active'").run(compactText2(reason, 1e3), time, role.id);
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
    this.db.prepare("UPDATE role_generations SET status='rejected',health='rejected',retirement_reason=?,ended_at=? WHERE id=? AND status='bootstrapping'").run(compactText2(reason, 2e3), nowIso2(), candidateId);
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
    const time = nowIso2();
    const id = newId2("fact");
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
        compactText2(input.content, 2e4),
        input.authority,
        compactText2(input.source, 1e3) || null,
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
    const time = nowIso2();
    const id = input.task_id || newId2("task");
    const role = input.owner_role ? this.getRole(project2, input.owner_role) : null;
    this.db.prepare(`INSERT INTO tasks(id,project_id,owner_role_id,title,goal,status,scope,acceptance_criteria,payload,architecture_epoch,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_role_id=excluded.owner_role_id,title=excluded.title,
      goal=excluded.goal,status=excluded.status,scope=excluded.scope,acceptance_criteria=excluded.acceptance_criteria,
      payload=excluded.payload,updated_at=excluded.updated_at`).run(
      id,
      project2.id,
      role?.id || null,
      compactText2(input.title, 300),
      compactText2(input.goal, 5e3),
      input.status || "pending",
      compactText2(input.scope, 2e3),
      JSON.stringify(uniqueStrings2(input.acceptance_criteria)),
      JSON.stringify(input.payload ?? {}),
      this.projectEpoch(project2),
      time,
      time
    );
    if (input.depends_on !== void 0) {
      this.db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
      const insert = this.db.prepare("INSERT INTO task_dependencies(task_id,depends_on) VALUES(?,?)");
      for (const dependency of uniqueStrings2(input.depends_on)) insert.run(id, dependency);
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
    const id = input.message_id || newId2("msg");
    const time = nowIso2();
    this.db.prepare(`INSERT INTO messages(id,project_id,type,from_role_id,to_role_id,from_generation,task_id,scope,architecture_epoch,payload,evidence_refs,reply_to,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(
      id,
      project2.id,
      input.type,
      from.id,
      to.id,
      input.from_generation,
      input.task_id || null,
      compactText2(input.scope, 2e3),
      input.architecture_epoch,
      JSON.stringify(input.payload),
      JSON.stringify(uniqueStrings2(input.evidence_refs)),
      input.reply_to || null,
      "pending",
      time
    );
    const row = this.db.prepare(`SELECT m.*,fr.role_key from_role,tr.role_key to_role FROM messages m
      JOIN roles fr ON fr.id=m.from_role_id JOIN roles tr ON tr.id=m.to_role_id WHERE m.id=?`).get(id);
    const conflicts = row.type !== input.type || row.from_role !== from.role_key || row.to_role !== to.role_key || Number(row.from_generation) !== input.from_generation || Number(row.architecture_epoch) !== input.architecture_epoch || String(row.task_id || "") !== String(input.task_id || "") || String(row.scope || "") !== compactText2(input.scope, 2e3) || String(row.reply_to || "") !== String(input.reply_to || "") || stableJson(parseJson(row.payload, null)) !== stableJson(input.payload) || stableJson(parseJson(row.evidence_refs, [])) !== stableJson(uniqueStrings2(input.evidence_refs));
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
    const time = nowIso2();
    this.db.prepare("UPDATE messages SET status='delivered',delivered_at=coalesce(delivered_at,?) WHERE to_role_id=? AND status='pending'").run(time, role.id);
    return rows.map((row) => ({ ...row, payload: parseJson(row.payload, {}), evidence_refs: parseJson(row.evidence_refs, []) }));
  }
  acknowledgeMessage(project2, roleKey, messageId) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    this.db.prepare("UPDATE messages SET status='acknowledged',acknowledged_at=? WHERE id=? AND to_role_id=?").run(nowIso2(), messageId, role.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND to_role_id=?").get(messageId, role.id);
    if (!row) throw new Error("MESSAGE_NOT_FOUND");
    return row;
  }
  claimMessageWake(project2, messageId) {
    this.ensureProject(project2);
    const time = nowIso2();
    const claimed = this.db.prepare(`UPDATE messages SET wake_status='running',wake_error=NULL,wake_started_at=?,wake_completed_at=NULL
      WHERE id=? AND project_id=? AND wake_status IN ('idle','failed')`).run(time, messageId, project2.id);
    if (Number(claimed.changes) === 0) return null;
    return this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project2.id);
  }
  finishMessageWake(project2, messageId) {
    this.db.prepare("UPDATE messages SET wake_status='completed',wake_error=NULL,wake_completed_at=? WHERE id=? AND project_id=?").run(nowIso2(), messageId, project2.id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=?").get(messageId, project2.id);
    if (!row) throw new Error("MESSAGE_NOT_FOUND");
    return row;
  }
  failMessageWake(project2, messageId, error) {
    this.db.prepare("UPDATE messages SET wake_status='failed',wake_error=?,wake_completed_at=? WHERE id=? AND project_id=?").run(compactText2(error, 4e3), nowIso2(), messageId, project2.id);
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
    const time = nowIso2();
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
    const id = newId2("env");
    const time = nowIso2();
    this.db.prepare(`INSERT INTO change_envelopes(id,task_id,owner_role_id,architecture_epoch,intent,allowed_scope,expected_symbols,constraints,non_goals,tests,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.task_id,
      role.id,
      this.projectEpoch(project2),
      compactText2(input.intent, 5e3),
      JSON.stringify(uniqueStrings2(input.allowed_scope)),
      JSON.stringify(uniqueStrings2(input.expected_symbols)),
      JSON.stringify(uniqueStrings2(input.constraints)),
      JSON.stringify(uniqueStrings2(input.non_goals)),
      JSON.stringify(uniqueStrings2(input.tests)),
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
    const paths = uniqueStrings2(actualPaths, 1e3);
    const violations = paths.filter((path) => !matchesAny(path.replace(/\\/g, "/"), allowed));
    const status = violations.length ? "violated" : "passed";
    this.db.prepare("UPDATE change_envelopes SET actual_paths=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify(paths), status, nowIso2(), envelopeId);
    return { ...this.db.prepare("SELECT * FROM change_envelopes WHERE id=?").get(envelopeId), violations };
  }
  createRotation(project2, roleKey, reason) {
    const role = this.getRole(project2, roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const old = this.activeGeneration(project2, roleKey);
    const id = newId2("rotation");
    const time = nowIso2();
    const checkpoint = this.context(project2, roleKey);
    this.db.prepare(`INSERT INTO rotations(id,role_id,old_generation_id,state,reason,checkpoint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, role.id, old?.id || null, "ROTATION_PENDING", compactText2(reason, 2e3), JSON.stringify(checkpoint), time, time);
    return this.db.prepare("SELECT * FROM rotations WHERE id=?").get(id);
  }
  updateRotation(rotationId, state, input = {}) {
    const time = nowIso2();
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
      newId2("evt"),
      project2.id,
      input.role_id || null,
      input.generation_id || null,
      input.event_key || null,
      input.event_type,
      JSON.stringify(input.payload ?? null),
      nowIso2()
    );
    return Number(result.changes) > 0;
  }
  observeGeneration(project2, threadId, input) {
    const binding = this.getGenerationByThread(project2, threadId);
    if (!binding) return null;
    const inserted = this.recordEvent(project2, { event_type: input.event, ...input.eventKey ? { event_key: input.eventKey } : {}, role_id: binding.role.id, generation_id: binding.generation.id });
    if (!inserted) return this.getGenerationByThread(project2, threadId).generation;
    const time = nowIso2();
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

// ../codex-role-runtime/src/project.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync, realpathSync as realpathSync2 } from "node:fs";
import { basename as basename2, dirname as dirname2, resolve as resolve3 } from "node:path";
function git2(cwd2, args2) {
  try {
    return execFileSync2("git", args2, { cwd: cwd2, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function resolveProject2(input = process.cwd()) {
  let current = resolve3(input);
  if (!existsSync(current)) throw new Error(`Working directory does not exist: ${current}`);
  current = realpathSync2(current);
  const root = git2(current, ["rev-parse", "--show-toplevel"]) ?? current;
  const commonRaw = git2(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitCommonDir = commonRaw ? resolve3(root, commonRaw) : null;
  const remote = git2(root, ["config", "--get", "remote.origin.url"]);
  const identity = gitCommonDir || remote || root.toLowerCase();
  return {
    id: stableId(identity),
    root,
    name: basename2(root) || basename2(dirname2(root)),
    remote,
    gitCommonDir,
    branch: git2(root, ["branch", "--show-current"]),
    revision: git2(root, ["rev-parse", "HEAD"])
  };
}

// src/cli.ts
import { resolve as resolve4 } from "node:path";
var [command = "status", ...rest] = process.argv.slice(2);
function option(name) {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : void 0;
}
function positional() {
  return rest.filter((value, index) => !value.startsWith("--") && (index === 0 || !rest[index - 1]?.startsWith("--")));
}
var cwd = option("--cwd") || process.cwd();
var args = positional();
var store = new MemoryStore();
var project = resolveProject(cwd);
try {
  let output;
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
      const canonicalRoot = resolve4(project.root);
      if (!confirmedRoot || resolve4(confirmedRoot).toLowerCase() !== canonicalRoot.toLowerCase()) {
        throw new Error(`RESET_CONFIRMATION_REQUIRED: rerun with --confirm-root "${project.root}"`);
      }
      const roleStore = new RoleStore();
      try {
        const roleProject = resolveProject2(cwd);
        output = {
          ok: true,
          root: project.root,
          role_runtime: roleStore.resetProject(roleProject),
          project_memory: store.resetProject(project),
          next: "Start a new Codex task and send \u521D\u59CB\u5316\u89D2\u8272\u7F16\u6392 to rebuild from zero."
        };
      } finally {
        roleStore.close();
      }
      break;
    }
    default:
      throw new Error("Usage: cli.mjs [doctor|status|task [id]|search <query>|checkpoint|consolidate [--apply]|reset-project --confirm-root <exact-project-root>] [--cwd <path>]");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}
`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
} finally {
  store.close();
}
