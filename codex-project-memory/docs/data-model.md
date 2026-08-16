# Data model

The database uses WAL mode, foreign keys, a five-second busy timeout, and six primary tables:

- `projects`: repository/worktree identity and the last observed root.
- `tasks`: compact active/completed task snapshots, branch scope, acceptance criteria, open loops, and completion gate policy.
- `memories`: curated and episodic memory with authority, confidence, importance, status, supersession, expiry, path/symbol/error scope, and recall statistics.
- `memories_fts`: FTS5 projection maintained by triggers.
- `events`: redacted and bounded user/tool/session observations with session, turn, and tool-use identifiers.
- `verifications`: objective build/test/review evidence tied to a task and Git revision.
- `checkpoints`: immutable atomic task snapshots created manually and before compaction.

Authority values are `user_decision`, `project_authority`, `agent_inference`, `tool_observation`, `external_evidence`, and `historical_attempt`. They describe provenance, not a general priority score. Memory never overrides the current user or repository instructions.

Human-readable `MEMORY.md` and task JSON files are generated from SQLite beneath the shared plugin data root (`PLUGIN_DATA` for hooks and the matching `CODEX_PROJECT_MEMORY_HOME` for MCP), under `projects/<project-id>/`. SQLite remains the machine source of truth.
