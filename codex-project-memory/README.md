# Codex Project Memory

A local Codex plugin for durable project memory during long-running software work. It preserves a versioned project plan, the active work item, exact next action, decisions, failed approaches, verification freshness, Git state, and atomic checkpoints across compaction, resumes, and handoffs.

The plugin is intentionally limited to memory. It does not create or coordinate roles, agents, or Codex tasks.

It is local-only, offline, requires no OpenAI API key, and uses SQLite FTS5 rather than an external embedding service.

## Install

Requirements: Codex desktop or Codex CLI with plugin support, Node.js 22.5 or newer, npm, and Git when repository-aware identity is desired.

Windows:

```powershell
npm ci
npm test
.\scripts\install.ps1
```

macOS/Linux:

```sh
npm ci
npm test
sh ./scripts/install.sh
```

Restart Codex and start a new task after installation. Review and trust the plugin Hooks with `/hooks`. The plugin exposes only the `project_memory` MCP server.

## Normal workflow

The bundled `project-memory` skill applies to substantial multi-step engineering tasks:

1. `plan_get` and `task_get` check the durable project mainline before work begins.
2. `plan_upsert` stores the project goal, definition of done, current milestone, critical constraints, and open user decisions. Semantic changes increment `revision`.
3. `task_upsert` stores the active work item, acceptance state, blockers, and first-class `exact_next_action`. Semantic changes increment `version`.
4. `memory_search` recalls relevant decisions, failures, paths, symbols, and error signatures; `memory_store` writes only durable, provenance-labelled information.
5. `verification_record` binds objective evidence to the current plan revision, task version, Git revision, and workspace digest.
6. `task_checkpoint` materializes the deterministic Mainline Capsule before a handoff; `PreCompact` does this automatically.
7. `task_complete` succeeds only when the completion gate is satisfied.

`NONE` means a field was checked and is empty. `UNKNOWN` means it could not be established and must not be treated as empty. Verification is explicitly labelled `CURRENT`, `STALE`, `NONE_CURRENT`, or `UNKNOWN`.

## MCP tools

| Tool | Purpose |
|---|---|
| `status` | Show project identity, active task, counts, database, and export paths |
| `mainline_get` | Read the deterministic Mainline Capsule |
| `plan_get` | Read the active or explicit versioned plan |
| `plan_upsert` | Idempotently update the project goal and plan revision |
| `task_get` | Read an active or explicit task |
| `task_upsert` | Create or update the versioned active work item and exact next action |
| `task_checkpoint` | Save an immutable atomic checkpoint |
| `task_complete` | Complete a task only after gate conditions pass |
| `memory_store` | Store a provenance-labelled memory |
| `memory_search` | Search with FTS5 and path, symbol, error, task, and authority ranking |
| `memory_get` | Inspect one record and its lineage |
| `memory_supersede` | Replace stale memory while preserving history |
| `memory_archive` | Soft-delete a memory from active recall |
| `verification_record` | Save build, test, or review evidence |
| `memory_consolidate` | Preview or archive exact duplicates only |

Always pass the current repository directory as `cwd`.

## Reset one project

Type `/` in a new Codex task and choose **Reset Project Memory** (`reset-project`). The explicit-only skill resolves the current project root and calls a guarded CLI command. It deletes only that project's tasks, memories, events, verifications, checkpoints, and generated exports.

The command requires the exact project root twice:

```powershell
$projectRoot = "E:\Github\example\project"
node --no-warnings "$env:USERPROFILE\plugins\codex-project-memory\dist\cli.mjs" reset-project --cwd $projectRoot --confirm-root $projectRoot
```

The reset cannot be undone by the plugin. Start a new Codex task afterward to rebuild memory from zero.

## Hook behavior

| Hook | Behavior |
|---|---|
| `SessionStart(startup/resume/clear/compact)` | Rebuild and inject the Mainline Capsule from canonical SQLite and current Git state |
| `UserPromptSubmit` | Recall memory relevant to the new request |
| Ordinary tool calls | Do not inject project memory context |
| `PostToolUse` | Capture bounded, redacted objective evidence and low-importance failures |
| `PreCompact` | Save an idempotent atomic checkpoint and `last_good_capsule.json`; never calls an LLM |
| `PostCompact` | Record telemetry only; it is not an injection point |
| `Stop` | Enforce the opt-in project completion gate |
| `SessionEnd` | Refresh human-readable exports |

After compaction, Codex emits `SessionStart` with `source=compact`; the Hook immediately rebuilds the capsule from the database and current repository state before the next model request. It never summarizes the preceding capsule or compact summary. If current materialization fails, the last digest-verified checkpoint is injected in explicit `degraded` mode. Hook-injected memory is historical context, never a higher-priority instruction source.

The normal Project Memory injection target is bounded to 6,500 characters; compact recovery is bounded to 6,000 and prompt recall to 4,000. Ordinary tool calls do not add a memory context injection. This keeps the absolute memory budget small for both 128k and 256k context models.

## Storage

Hooks, MCP, and the CLI use `~/.codex/plugin-data/codex-project-memory` by default. `PLUGIN_DATA` and `CODEX_PROJECT_MEMORY_HOME` can override the location for installation or testing.

```text
<data-root>/
  project-memory.sqlite3
  projects/<project-id>/
    MAINLINE.md
    MEMORY.md
    PLAN.json
    last_good_capsule.json
    tasks/<task-id>.json
```

SQLite is the machine source of truth; `MEMORY.md` is an inspectable projection. See [architecture](./docs/architecture.md), [data model](./docs/data-model.md), and [security](./SECURITY.md).

## Development

```sh
npm ci
npm test
npm run doctor
npm run pack:check
```

The tests cover completion gates, plan/task revision idempotency, deterministic capsule budgets, zero-curated-memory recovery, verification staleness, v1 database migration, lifecycle Hooks, immediate post-compaction rehydration, checkpoint fallback, reset safety, and real MCP stdio exchanges.

## References and acknowledgements

This project was independently implemented for Codex. Its memory design research was informed by these open-source agent projects; their source code is not bundled or copied into this plugin:

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — persistent learning, experience-derived skills, and cross-session retrieval.
- [OpenClaw](https://github.com/openclaw/openclaw) — file-backed long-term memory, memory search, and pre-compaction context preservation.

## License

Codex Project Memory is released under the [MIT License](./LICENSE).
