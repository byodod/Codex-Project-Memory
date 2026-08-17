# Codex Project Memory

A local Codex plugin for durable project memory during long-running software work. It preserves goals, acceptance criteria, decisions, failed approaches, verification evidence, checkpoints, and next steps across compaction, resumes, and handoffs.

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

1. `task_get` checks for active project state.
2. `task_upsert` creates or refreshes the goal, acceptance criteria, completed items, next steps, and blockers.
3. `memory_search` recalls relevant decisions, failures, paths, symbols, and error signatures.
4. `memory_store` writes only durable, provenance-labelled information.
5. `verification_record` saves objective build, test, or review evidence.
6. `task_checkpoint` captures exact state before a handoff; `PreCompact` does this automatically.
7. `task_complete` succeeds only when the completion gate is satisfied.

## MCP tools

| Tool | Purpose |
|---|---|
| `status` | Show project identity, active task, counts, database, and export paths |
| `task_get` | Read an active or explicit task |
| `task_upsert` | Create or update the compact task snapshot |
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
| `SessionStart(startup/resume/clear/compact)` | Rehydrate the active task, recent verification, and curated memory |
| `UserPromptSubmit` | Recall memory relevant to the new request |
| `PreToolUse` | Recall memory relevant to the pending tool call |
| `PostToolUse` | Capture bounded, redacted objective evidence and low-importance failures |
| `PreCompact` | Save an atomic task checkpoint before compaction |
| `PostCompact` | Complete the lifecycle without injecting ignored output |
| `Stop` | Enforce the opt-in project completion gate |
| `SessionEnd` | Refresh human-readable exports |

After compaction, Codex emits `SessionStart` with `source=compact`; the Hook immediately injects the active task snapshot before the next model request. Hook-injected memory is historical context, never a higher-priority instruction source.

## Storage

Hooks, MCP, and the CLI use `~/.codex/plugin-data/codex-project-memory` by default. `PLUGIN_DATA` and `CODEX_PROJECT_MEMORY_HOME` can override the location for installation or testing.

```text
<data-root>/
  project-memory.sqlite3
  projects/<project-id>/
    MEMORY.md
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

The tests cover completion gates, FTS recall, supersession, duplicate consolidation, lifecycle Hooks, immediate post-compaction rehydration, reset safety, and real MCP stdio exchanges.

## References and acknowledgements

This project was independently implemented for Codex. Its memory design research was informed by these open-source agent projects; their source code is not bundled or copied into this plugin:

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — persistent learning, experience-derived skills, and cross-session retrieval.
- [OpenClaw](https://github.com/openclaw/openclaw) — file-backed long-term memory, memory search, and pre-compaction context preservation.

## License

Codex Project Memory is released under the [MIT License](./LICENSE).
