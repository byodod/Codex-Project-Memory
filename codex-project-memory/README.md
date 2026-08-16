# Codex Project Runtime

A single Codex plugin that combines long-horizon project memory with persistent role orchestration. It bundles two local MCP control planes, one integrated lifecycle Hook, SQLite FTS5 recall, a user-facing Liaison, an internal Coordinator, typed role routing, replaceable role task generations, checkpoints, verification evidence, and a completion gate.

It is designed to prevent the failures that matter during long development work:

- losing the goal or open loops after compaction or resume;
- retrying a previously failed approach;
- forgetting why a decision was made;
- treating tool output or web text as authoritative instructions;
- claiming completion before acceptance criteria and verification are satisfied.

The plugin is local-only, offline, and requires no OpenAI API key. The former standalone Role Runtime remains a source component in this repository, but users install only `codex-project-memory`; the installer removes the duplicate standalone installation while preserving its existing role database.

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

Then restart Codex and begin a new task. Plugin hooks are non-managed code: open `/hooks`, inspect them, and trust the current definitions. The plugin exposes `project_memory` and `role_runtime` MCP servers.

To initialize the default role topology, send `初始化角色编排`. The integrated Hook creates the four role definitions and binds the current task as `role://liaison`. In that same turn, the Liaison model uses Codex desktop task interfaces to find or create the Coordinator and records the actual task id with `role_attach`. Repeating the exact prompt from another task hands the Liaison generation off safely. If any bound role task is missing, archived, deleted, or unavailable, the model simply creates a new desktop task and attaches it; the old generation is retired. MCP calls persist role state and typed messages but never start Codex CLI, App Server, or hidden model turns.

Desktop role creation follows the app schema literally: the selected project id appears only at `target.projectId`, never as an extra top-level `projectId`. Persistent roles use the live local checkout. If worktree setup returns only `clientThreadId`, orchestration waits for that task's real `threadId`; it does not create a duplicate, attach the client id, or substitute a fork.

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

Role Runtime adds role definition/status, `role_attach`, role facts, task graph, typed mailboxes, Liaison-to-Coordinator request/result persistence, change envelopes, architecture epochs, and atomic generation replacement. Project Memory remains the durable user-level completion contract; Role Runtime is the internal execution graph. Their task ids are separate namespaces: Role Runtime `task_id` fields only accept Role Runtime task ids, while a Project Memory association belongs in `payload.project_memory_task_id`.

## Reset one project completely

The installed plugin includes a destructive, project-scoped reset command. It removes the resolved project's Project Memory tasks, memories, events, verifications, checkpoints and generated exports, plus all Role Runtime roles, generations, task graph, messages, rotations, events and change envelopes. Other projects are not touched.

After installing or updating the plugin and starting a new Codex task, type `/` in the composer and choose **Reset Project Runtime** (`reset-project`). Enabled skills are shown in Codex's slash-command list, so this is the normal user-facing reset entry. The skill is explicit-only: Codex will not select it implicitly from an ordinary cleanup request. It resolves the current project root and delegates the destructive operation to the guarded CLI below.

The command requires the same exact project root twice, so a mistyped `cwd` cannot be silently confirmed:

```powershell
$projectRoot = "E:\Github\4.6\Game-10"
node --no-warnings "$env:USERPROFILE\plugins\codex-project-memory\dist\cli.mjs" reset-project --cwd $projectRoot --confirm-root $projectRoot
```

This cannot be undone from the plugin. Close or stop active role work first. Existing Codex tasks may remain visible in task history, but after reset they have no role authority or durable project state. Start a new Codex task and send `初始化角色编排` to rebuild the project from zero.

## Hook behavior

| Hook | Behavior |
|---|---|
| `SessionStart(startup/resume/clear/compact)` | Merge task/memory rehydration with the active role anchor |
| `UserPromptSubmit` | Recall relevant memory, initialize exact role prompts, and reject stale role generations |
| `PreToolUse` | Merge relevant memory with role permission enforcement |
| `PostToolUse` | Capture bounded objective evidence and role events |
| `PreCompact` / `PostCompact` | Checkpoint project state and update role-generation health |
| `Stop` | Enforce the project completion gate and record role stop state |
| `SessionEnd` | Refresh memory exports and close the role-generation session |

Memory recall never rewrites tool calls. Role policy can deny stale generations or tools outside a role's charter. Automatic failure capture remains low-importance episodic memory until explicitly curated.

## Storage and inspection

Hooks, MCP, and the CLI all use `~/.codex/plugin-data/codex-project-memory` by default. Codex supplies `PLUGIN_DATA` to Hooks, while the installer gives MCP the same directory through `CODEX_PROJECT_MEMORY_HOME`; either variable can explicitly override the default for testing or migration. This avoids the old split where the CLI silently read `~/.codex-project-memory` while MCP used the plugin database.

```text
<data-root>/
  project-memory.sqlite3
  projects/<project-id>/
    MEMORY.md
    tasks/<task-id>.json
```

Existing Role Runtime data remains under `~/.codex/plugin-data/codex-role-runtime/role-runtime.sqlite3`, so upgrading to the unified plugin does not reset active roles or audit history.

Inspect the current project without Codex:

```powershell
node --no-warnings .\dist\cli.mjs status --cwd C:\path\to\repo
node --no-warnings .\dist\cli.mjs search SaveSystem --cwd C:\path\to\repo
node --no-warnings .\dist\cli.mjs checkpoint --cwd C:\path\to\repo
node --no-warnings .\dist\cli.mjs reset-project --cwd C:\path\to\repo --confirm-root C:\path\to\repo
```

`MEMORY.md` is an inspectable projection. SQLite is the machine source of truth. See [architecture](./docs/architecture.md), [data model](./docs/data-model.md), and [security](./SECURITY.md).

## Development and verification

```sh
npm ci
npm test
npm run doctor
npm run pack:check
```

The tests exercise task completion gates, FTS relevance and recall metadata, supersession, duplicate consolidation, merged Hook behavior, desktop-task attachment/replacement, durable request/result routing, and real stdio exchanges with both MCP servers.

## Updating a local installation

Run the install script again. It builds first, preserves the previous plugin source as a timestamped backup, refreshes the personal marketplace entry, and asks Codex to reinstall the plugin. Restart Codex and use a new task so the new skill, MCP server, and Hook hashes are loaded. Review changed Hook definitions again with `/hooks`.

## References and acknowledgements

This project was independently implemented for Codex. Its design research was informed by these open-source agent projects; their source code is not bundled or copied into this plugin:

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — persistent learning, experience-derived skills, and cross-session retrieval.
- [OpenClaw](https://github.com/openclaw/openclaw) — file-backed long-term memory, memory search, and pre-compaction context preservation.

## License

Codex Project Memory is released under the [MIT License](./LICENSE).
