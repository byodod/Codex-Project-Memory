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

When the user sends exactly `初始化角色编排`, `启动角色编排`, or `initialize role orchestration`, the `UserPromptSubmit` hook idempotently creates the standard Liaison, Coordinator, Architect, and Verifier topology and binds the current task to `role://liaison`.

After the hook binds the Liaison:

1. Call `status` with the current `cwd`.
2. If the Coordinator has no active generation, call `role_start` for `coordinator`. Do this as part of the same initialization turn; do not ask the user to run a CLI command.
3. Confirm that the user-facing entry and Coordinator are ready. Do not expose internal thread ids.

For each later substantive user request, clarify only material ambiguity, then call `liaison_request` with the current Liaison generation and a faithful structured request. Translate the returned Coordinator response into concise user-facing language. Do not implement, schedule, architect, or verify work inside the Liaison task.

If custom initialization is required, use `project_initialize`, `project_configure`, and `role_define`. Long-lived governance and owner roles should normally be `read_only`; use short-lived `workspace_write` workers for implementation. Record critical invariants, accepted decisions, ownership, open questions, failures, and artifacts with `role_state_put`, never transcript summaries.

## Bind or create a generation

- For advanced recovery or custom topology work, an existing unbound Codex task can submit exactly `role://bind <role-key>`. The `UserPromptSubmit` hook binds generation 1 if the role is unbound.
- Alternatively call `role_bind` with an explicit thread id.
- For a fresh App Server managed thread, use the CLI `start <role-key>` command.
- Do not soft-switch one thread to another role.

## Orchestrate work

1. Keep the Liaison user-focused and the Coordinator compact. The Liaison uses `liaison_request`; the Coordinator uses `task_upsert` and `task_graph`, storing pointers and blockers rather than all module knowledge.
2. Route decisions through the semantic owner. Use `message_send` with a typed message and the sender's active generation plus current architecture epoch.
3. Read a role's work with `message_inbox`; acknowledge consumed messages with `message_ack`.
4. Give a writable worker a `change_envelope_create` packet: intent, allowed scope regexes, symbols, constraints, non-goals, and tests.
5. Compare actual changed paths with `change_envelope_check` before accepting the result.
6. Use a fresh Verifier generation for important acceptance work.

## Rotate safely

Rotation is normal lifecycle, not emergency repair. Consider it after a milestone, material charter/architecture change, first compaction at a task boundary, or whenever generation health becomes `rotation_required`.

Preferred one-command flow:

`node <plugin-root>/dist/cli.mjs rotate <role-key> --cwd <project> --reason <reason>`

The CLI performs `ROTATION_PENDING → DRAINING → CHECKPOINTING → VALIDATING → BOOTSTRAPPING → CUTOVER`, creates a new thread through Codex App Server, sets its native goal, validates structured bootstrap output, and switches atomically. If bootstrap fails, the candidate is rejected and the old generation stays active.

For an external driver, use `rotation_prepare`, `rotation_candidate_register`, and `rotation_cutover` in that order.

## Hooks

- `SessionStart` and `UserPromptSubmit` inject a compact role anchor; an exact initialization prompt creates the standard topology and binds the current task as Liaison.
- `UserPromptSubmit` and `PreToolUse` reject retired generations.
- `PreToolUse` enforces the role's denied-tool policy.
- `PreCompact` records a checkpoint event; `PostCompact` increments generation health once per event.
- Hook events are advisory evidence except for explicit stale-generation and tool-policy blocks.

Current user instructions, repository `AGENTS.md`, accepted ADRs, and CI remain authoritative over stored role state.
