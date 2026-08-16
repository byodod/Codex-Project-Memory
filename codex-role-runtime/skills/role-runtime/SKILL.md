---
name: role-runtime
description: Keep persistent project roles independent from replaceable Codex thread generations. Use when the user asks to initialize role orchestration, define roles, assign semantic ownership, route work between roles, use a User Liaison, inspect a role mailbox or task graph, enforce role permissions, start or rotate a role session, recover a stale role thread, or orchestrate long modular development with Liaison, Coordinator, Architect, Module Owner, Worker, and Verifier responsibilities. Do not use for ordinary short tasks that need no persistent role topology.
---

# Codex Role Runtime

Use the `role_runtime` MCP tools as the authoritative control plane. Role identity and structured state live outside model context; a Codex thread is only one replaceable generation.

## Invariants

- Address persistent peers as `role://<role-key>`, never by stored thread id.
- A thread belongs to one role for life. Never reuse a thread under a different role.
- A role has at most one active generation.
- Only the active generation may write role state or send authoritative results.
- Validate a candidate bootstrap before atomic cutover; keep the old generation active on failure.
- Carry the current `architecture_epoch` in messages, tasks, and change envelopes. Stale work must be refreshed.
- `role://liaison` is the sole user-facing role. It exchanges requests and results only with `role://coordinator`; internal roles do not require the user to contact them.

## Default one-prompt start

When the user sends exactly `初始化角色编排`, `启动角色编排`, or `initialize role orchestration`, the `UserPromptSubmit` hook idempotently creates the standard Liaison, Coordinator, Architect, and Verifier topology and binds the current task to `role://liaison`. If another Liaison task is active, the exact prompt deterministically hands the Liaison generation off to the current task and retires the old generation while reusing the existing Coordinator.

The Hook starts the Coordinator itself before the Liaison model turn. After it binds the Liaison:

1. Call `status` with the current `cwd`.
2. Confirm the Coordinator is active. If startup was interrupted, call the idempotent `role_start` for `coordinator` to recover it; do not ask the user to run a CLI command. `role_start` verifies that the recorded App Server task still exists and replaces a missing task after closing stale bootstrap/rotation residue.
3. Confirm that the user-facing entry and Coordinator are ready. Do not expose internal thread ids.

For each later substantive user request, clarify only material ambiguity, then call `liaison_request` with the current Liaison generation and a faithful structured request. It starts or repairs the Coordinator before routing and retries once if the task disappears between the health check and dispatch. The Coordinator returns its final reply as assistant text; it must not call `liaison_request` or `message_send` for that final reply because the outer request persists exactly one RESULT. Translate the returned response into concise user-facing language. Do not implement, schedule, architect, or verify work inside the Liaison task.

`liaison_request.task_id` and `message_send.task_id` refer only to tasks in the Role Runtime task graph. To associate a request with a Project Memory task, put that id in `payload.project_memory_task_id`; the two control-plane ids are intentionally not interchangeable.

If custom initialization is required, use `project_initialize`, `project_configure`, and `role_define`. Long-lived governance and owner roles should normally be `read_only`; use short-lived `workspace_write` workers for implementation. Record critical invariants, accepted decisions, ownership, open questions, failures, and artifacts with `role_state_put`, never transcript summaries.

## Bind or create a generation

- For advanced recovery or custom topology work, an existing unbound Codex task can submit exactly `role://bind <role-key>`. The `UserPromptSubmit` hook binds generation 1 if the role is unbound.
- Alternatively call `role_bind` with an explicit thread id.
- For a fresh App Server managed thread, use the CLI `start <role-key>` command.
- Do not soft-switch one thread to another role.

## Orchestrate work

1. Keep the Liaison user-focused and the Coordinator compact. The Liaison uses `liaison_request`; the Coordinator uses `task_upsert` and `task_graph`, storing pointers and blockers rather than all module knowledge.
2. Route decisions through the semantic owner. Use `message_send` with a typed message and the sender's active generation plus current architecture epoch. `ASSIGN`, `VERIFY_REQUEST`, and `HANDOFF` automatically create and wake a non-Coordinator recipient task. Reuse a stable `message_id`: completed dispatches deduplicate, while failed wakes can retry. Result traffic back to the Coordinator is mailbox-only so it cannot start a competing Coordinator turn.
3. Read a role's work with `message_inbox`; acknowledge consumed messages with `message_ack`.
4. Give a writable worker a `change_envelope_create` packet: intent, allowed scope regexes, symbols, constraints, non-goals, and tests.
5. Compare actual changed paths with `change_envelope_check` before accepting the result.
6. Use a fresh Verifier generation for important acceptance work.

## Rotate safely

Rotation is normal lifecycle, not emergency repair. Consider it after a milestone, material charter/architecture change, first compaction at a task boundary, or whenever generation health becomes `rotation_required`.

Preferred one-command flow:

`node <plugin-root>/dist/cli.mjs rotate <role-key> --cwd <project> --reason <reason>`

The CLI performs `ROTATION_PENDING → DRAINING → CHECKPOINTING → VALIDATING → BOOTSTRAPPING → CUTOVER`, creates a new thread through Codex App Server, validates an authoritative bootstrap packet locally, and switches atomically. Initialization does not set an active native goal or wait for a model echo. If bootstrap fails, the candidate is rejected and the old generation stays active. If SQLite says a generation is active but App Server reports that its task no longer exists, `role_start` closes incompatible stale rotation residue and uses this same deterministic cutover path to replace it exactly once.

For an external driver, use `rotation_prepare`, `rotation_candidate_register`, and `rotation_cutover` in that order.

## Hooks

- `SessionStart` and `UserPromptSubmit` inject a compact role anchor; an exact initialization prompt creates the standard topology and binds the current task as Liaison.
- `UserPromptSubmit` and `PreToolUse` reject retired generations and prevent bootstrapping candidates from starting recursive work before cutover.
- `PreToolUse` enforces the role's denied-tool policy.
- `PreCompact` records a checkpoint event; `PostCompact` increments generation health once per event.
- Hook events are advisory evidence except for explicit stale-generation and tool-policy blocks.

Current user instructions, repository `AGENTS.md`, accepted ADRs, and CI remain authoritative over stored role state.
