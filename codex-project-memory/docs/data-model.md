# Data model

The database uses WAL mode, foreign keys, a one-second busy timeout, and these primary tables:

- `projects`: repository/worktree identity and the last observed root.
- `plans`: versioned project goals, definitions of done, milestones, constraints, and open user decisions.
- `tasks`: versioned active/completed work items, branch/plan scope, exact next action, acceptance state, open loops, and completion gate policy.
- `memories`: curated and episodic memory with authority, confidence, importance, status, supersession, expiry, path/symbol/error scope, and recall statistics.
- `memories_fts`: FTS5 projection maintained by triggers.
- `events`: redacted and bounded user/tool/session observations with session, turn, and tool-use identifiers.
- `verifications`: objective build/test/review evidence tied to a plan revision, task version, Git revision, and workspace digest. Reads classify evidence as `CURRENT`, `STALE`, or `UNKNOWN`; absence is `NONE_CURRENT`.
- `checkpoints`: immutable atomic Mainline Capsule snapshots with schema/snapshot versions, state and capsule digests, and lifecycle identifiers. An unchanged state reuses the latest checkpoint.

Authority values are `user_decision`, `project_authority`, `agent_inference`, `tool_observation`, `external_evidence`, and `historical_attempt`. They describe provenance, not a general priority score. Memory never overrides the current user or repository instructions.

Human-readable `MAINLINE.md`, `MEMORY.md`, `PLAN.json`, task JSON, and `last_good_capsule.json` files are generated beneath the shared plugin data root (`PLUGIN_DATA` for hooks and the matching `CODEX_PROJECT_MEMORY_HOME` for MCP), under `projects/<project-id>/`. SQLite remains the machine source of truth; the last-good file is a read-only degraded fallback whose rendered digest is checked before use.
