# Architecture

```text
AGENTS.md / ADR (authority)         Current user request
              \                       /
               v                     v
               Codex agentic loop + Goal
                 |       |         |
        lifecycle hooks  |         MCP tools
                 \       |        /
                  Project Memory Engine
                /          |           \
       active task     curated memory   events/evidence
                \          |           /
                 SQLite WAL + FTS5 index
                           |
                   human-readable export
```

The plugin deliberately separates four concerns:

1. `AGENTS.md`, ADRs, and repository documentation remain authoritative project rules.
2. The active task is a compact, exact snapshot: goal, acceptance criteria, completed items, next steps, blockers, and gate policy.
3. Curated memories keep decisions, facts, constraints, failures, and tool quirks with provenance, confidence, supersession, task/file/symbol/error scope, and recall counts.
4. Episodic events and verification evidence preserve what actually happened without injecting the whole history into every prompt.

Repository identity uses the Git remote and common Git directory when available, so worktrees share project history while tasks remain branch-aware. Non-Git directories use their canonical path.

Retrieval starts with SQLite FTS5, then boosts exact symbols, paths, error signatures, the active task, importance, confidence, and authoritative provenance. Decisions do not decay merely because they are old; stale decisions are explicitly superseded.

No embedding model is required in V1. This keeps installation deterministic, private, offline, and cheap. A future semantic ranker can be added without changing the storage contract.
