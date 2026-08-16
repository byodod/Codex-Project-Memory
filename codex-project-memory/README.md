# Codex Project Memory

A Codex-native long-horizon memory plugin for software projects. It combines lifecycle Hooks, a local MCP server, SQLite FTS5, provenance labels, compact task snapshots, pre-compaction checkpoints, and a completion gate.

It is designed to prevent the failures that matter during long development work:

- losing the goal or open loops after compaction or resume;
- retrying a previously failed approach;
- forgetting why a decision was made;
- treating tool output or web text as authoritative instructions;
- claiming completion before acceptance criteria and verification are satisfied.

The plugin is local-only, offline, and requires no OpenAI API key.

## Install

Requirements: Codex/ChatGPT desktop or Codex CLI with plugin support, Node.js 22.5 or newer, npm, and Git when repository-aware identity is desired.

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

Then restart Codex and begin a new task. Plugin hooks are non-managed code: open `/hooks`, inspect them, and trust the current definitions. The MCP server is exposed as `project_memory`.

## Normal Codex workflow

The bundled `project-memory` skill automatically applies to substantial multi-step engineering tasks. Its expected flow is:

1. `task_get` checks whether the branch already has active state.
2. `task_upsert` creates or refreshes the goal, acceptance criteria, completed items, next steps, and blockers.
3. `memory_search` recalls relevant decisions, failures, paths, symbols, and error signatures before risky or repeated work.
4. `memory_store` writes only durable, provenance-labelled information.
5. `verification_record` saves objective build/test/review evidence.
6. `task_checkpoint` captures exact state before handoff; `PreCompact` does this automatically.
7. `task_complete` succeeds only when acceptance criteria are marked complete and blockers and next steps are empty.

The `Stop` Hook asks Codex for one continuation when an enabled active task still has open criteria, blockers, or next steps. `stop_hook_active` prevents loops.

## MCP tools

| Tool | Purpose |
|---|---|
| `status` | Show project identity, active task, counts, database, and export paths |
| `task_get` | Read an active or explicit task |
| `task_upsert` | Create/update the compact task snapshot |
| `task_checkpoint` | Save an immutable atomic checkpoint |
| `task_complete` | Complete a task only after gate conditions pass |
| `memory_store` | Store a provenance-labelled memory |
| `memory_search` | FTS5 plus path/symbol/error/task/authority ranking |
| `memory_get` | Inspect one record and its lineage |
| `memory_supersede` | Replace stale memory while preserving history |
| `memory_archive` | Soft-delete a memory from active recall |
| `verification_record` | Save build/test/review evidence |
| `memory_consolidate` | Preview or archive exact duplicates only |

Always pass the current repository directory as `cwd` when calling MCP tools.

## Hook behavior

| Hook | Behavior |
|---|---|
| `SessionStart(startup/resume/compact)` | Inject a short task rehydration pack and curated memory |
| `UserPromptSubmit` | Record a redacted prompt event and recall relevant history |
| `PreToolUse` | Recall file/symbol/error/failure context for Bash and edits |
| `PostToolUse` | Capture bounded, redacted objective tool evidence with a fast local write |
| `PreCompact` | Atomically checkpoint task and recent event identifiers |
| `Stop` | Continue once if the active completion gate remains open |
| `SessionEnd` | Refresh human-readable exports |

Hooks never rewrite or deny tool calls. Automatic failure capture remains low-importance episodic memory until explicitly curated.

## Storage and inspection

When installed, Codex supplies `PLUGIN_DATA` to hooks and the installer gives the MCP server the same per-plugin directory through `CODEX_PROJECT_MEMORY_HOME`. Standalone development uses `~/.codex-project-memory` or an explicit `CODEX_PROJECT_MEMORY_HOME`.

```text
<data-root>/
  project-memory.sqlite3
  projects/<project-id>/
    MEMORY.md
    tasks/<task-id>.json
```

Inspect the current project without Codex:

```powershell
node --no-warnings .\dist\cli.mjs status --cwd C:\path\to\repo
node --no-warnings .\dist\cli.mjs search SaveSystem --cwd C:\path\to\repo
node --no-warnings .\dist\cli.mjs checkpoint --cwd C:\path\to\repo
```

`MEMORY.md` is an inspectable projection. SQLite is the machine source of truth. See [architecture](./docs/architecture.md), [data model](./docs/data-model.md), and [security](./SECURITY.md).

## Development and verification

```sh
npm ci
npm test
npm run doctor
npm run pack:check
```

The tests exercise task completion gates, FTS/symbol ranking, supersession, duplicate consolidation, Hook rehydration/recall/checkpoint/redaction, and a real MCP stdio client/server exchange.

## Updating a local installation

Run the install script again. It builds first, preserves the previous plugin source as a timestamped backup, refreshes the personal marketplace entry, and asks Codex to reinstall the plugin. Restart Codex and use a new task so the new skill, MCP server, and Hook hashes are loaded. Review changed Hook definitions again with `/hooks`.
