---
name: role-runtime
description: Initialize and operate persistent Codex project roles together with durable project memory. Use when the user asks for role orchestration, a User Liaison or Coordinator, semantic ownership, typed role routing, task graphs, role permissions, generation startup or rotation, or recovery of a stale role task. Do not use for short work that needs neither persistent roles nor durable project state.
---

# Integrated Role Runtime

Use `role_runtime` for role identity, routing, ownership, mailboxes, policy, and replaceable Codex task generations. Use `project_memory` for the project-level goal, acceptance criteria, durable decisions, failures, verification evidence, and resumable next steps. They are two control planes in one plugin and one workflow; do not make the user coordinate them separately.

Do not use a host/global memory summary as a substitute for the repository-scoped Project Memory database. Read `project_memory.task_get` first and use `memory_search` for durable project history.

## One-prompt initialization

When the user sends exactly `初始化角色编排`, `启动角色编排`, or `initialize role orchestration`, the integrated Hook must:

1. Idempotently create Liaison, Coordinator, Architect, and Verifier roles.
2. Bind the current task to `role://liaison`, the only user-facing role. If another Liaison task is active, deterministically hand the Liaison generation off to the current task and retire the old generation.
3. Create and deterministically activate the Coordinator task before the Liaison model turn begins.

Afterward, call both `role_runtime.status` and `project_memory.task_get` with the current `cwd`. If the Coordinator startup was interrupted, call the idempotent `role_start`; do not ask the user to repair it. If no matching project-memory task exists for substantive work, create one with `task_upsert`.

## Shared operating model

- The Liaison clarifies user intent and uses `liaison_request`; it does not implement or internally coordinate work.
- The Coordinator owns the role task graph and routes work. It keeps the current project-memory task aligned with the user's goal, acceptance criteria, completed items, blockers, and next steps.
- Architect and module owners store role-specific charters, ownership, and invariants with `role_state_put`. Cross-role decisions and reusable project facts also go to `memory_store` with honest provenance.
- Workers receive a bounded change envelope and perform implementation. Record meaningful build/test/review results with `verification_record`.
- The Verifier independently checks acceptance. Only after criteria are satisfied should the Coordinator clear project-memory next steps/blockers and complete the task.

Project Memory is the durable user-level completion contract. Role Runtime tasks are the internal execution graph. Link a role task to the project-memory task in its payload when useful; never create contradictory sources of truth.

## Generation lifecycle

Address roles as `role://<role-key>`, never by task id. A task belongs to one role for life, and only the active generation may send authoritative results. `role_start` is idempotent. Rotation creates a candidate task, validates authoritative SQLite state locally, and atomically cuts over without setting an active goal or waiting for a model health echo. Failed candidates are rejected; the prior active generation remains authoritative.

Bootstrapping candidates may receive a role anchor but cannot accept prompts or tools before cutover. Retired and rejected generations are stale and must not continue work.

Before compaction, handoff, rotation, or completion, update the project-memory task and checkpoint it. Current user instructions, repository `AGENTS.md`, accepted ADRs, and fresh verification evidence outrank recalled history.
