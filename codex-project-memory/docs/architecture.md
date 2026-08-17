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
   versioned plan/task curated memory   events/evidence
                \          |           /
                 SQLite WAL + FTS5 index
                           |
            deterministic Mainline Capsule
                           |
       compact injection + human-readable export
```

The plugin deliberately separates five concerns:

1. `AGENTS.md`, ADRs, and repository documentation remain authoritative project rules.
2. The active plan is versioned canonical state: project goal, definition of done, current milestone, critical constraints, and open user decisions.
3. The active task is a versioned work item: goal, acceptance criteria, completed items, blockers, exact next action, and gate policy.
4. Curated memories keep decisions, facts, constraints, failures, and tool quirks with provenance, confidence, supersession, task/file/symbol/error scope, and recall counts.
5. Episodic events and verification evidence preserve what actually happened without injecting the whole history into every prompt.

The Mainline Capsule is a fixed-schema materialized projection. Every render starts from the current plan, task, verification, Git, checkpoint, and failure records; it never summarizes a prior capsule. `exact_next_action` is explicit when available and otherwise deterministically derived from the first next step, unsatisfied acceptance criterion, or blocker.

`PreCompact` creates a checkpoint only when the canonical state digest changed. `PostCompact` records telemetry only. `SessionStart(source=compact)` reconciles current Git state and injects a newly rendered capsule. A digest-verified `last_good_capsule.json` provides the sole `degraded` fallback; there is no recovery state machine beyond `full` and `degraded`.

Repository identity uses the Git remote and common Git directory when available, so worktrees share project history while tasks remain branch-aware. Non-Git directories use their canonical path.

Retrieval starts with SQLite FTS5, then boosts exact symbols, paths, error signatures, the active task, importance, confidence, and authoritative provenance. Decisions do not decay merely because they are old; stale decisions are explicitly superseded.

No embedding or summarization model is required. This keeps installation deterministic, private, offline, and cheap. A future semantic ranker can be added without changing the canonical mainline contract.
