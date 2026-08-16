---
name: role-runtime
description: Keep persistent project roles independent from replaceable Codex desktop task generations. Use when the user asks to initialize role orchestration, use a User Liaison or Coordinator, route typed role work, inspect role state, attach or replace role tasks, or orchestrate long modular development. Do not use for ordinary short tasks that need no persistent role topology.
---

# Codex Role Runtime

Use `role_runtime` as the durable role control plane and Codex desktop task tools as the task transport. The MCP server stores identities, generations, task graphs, mailboxes, policies, and checkpoints. It never queries, creates, resumes, archives, or runs Codex tasks and never invokes the Codex CLI or App Server.

## Invariants

- Address roles as `role://<role-key>`, never by task id.
- One task belongs to one role for life; one role has at most one active generation.
- Only the active generation may write role state or send authoritative results.
- `role://liaison` is the sole user-facing role and exchanges user intent only with `role://coordinator`.
- Carry the current `architecture_epoch` in typed work. Reject stale work.

## Initialize in one user turn

When the user sends exactly `初始化角色编排`, `启动角色编排`, or `initialize role orchestration`, the Hook creates the Liaison, Coordinator, Architect, and Verifier definitions and binds the current task as Liaison. If another Liaison task is active, it is retired and the current task becomes the new generation.

In that same model turn:

1. Call `role_runtime.status`.
2. Use Codex desktop `list_projects` and `list_threads`/`read_thread` to check the stored Coordinator task id.
3. If no Coordinator is attached, or the attached task is missing, archived, deleted, or unavailable, call desktop `create_thread` for a local task in the current project. Use a prompt containing the Coordinator role anchor and tell it to await routed work.
4. Call `role_runtime.role_attach` with `role_key: "coordinator"` and the returned task id. A different id retires the old generation automatically.
5. Report that Liaison and Coordinator are ready. Do not expose internal task ids unless debugging requires them.

Do not attempt to restore an unavailable task. Create a replacement and attach it.

## Route a Liaison request

1. Call `liaison_request` with the current Liaison generation and a stable `message_id`. This only persists intent and returns a Coordinator task id plus a prompt.
2. If its recipient status is `needs_task`, create a desktop task and call `role_attach`, then call `liaison_request` again with the same `message_id`.
3. Use desktop `send_message_to_thread` with the returned prompt.
4. Use desktop `wait_threads`, then `read_thread` when needed, to obtain the result.
5. Call `liaison_result` once with the request message id and result text. This durably records one RESULT and acknowledges the request.
6. Translate the result into user-facing language.

`liaison_request.task_id` and `message_send.task_id` accept Role Runtime task-graph ids only. Put a Project Memory task association in `payload.project_memory_task_id`.

## Route internal work

The Coordinator owns the internal role graph. For an assignment:

1. Persist it with `message_send`; the result contains the recipient's attached desktop task id or `needs_task`.
2. If needed, create a local desktop task for that role and call `role_attach`. If the stored task is archived, deleted, missing, or unavailable, create a new one and attach it directly.
3. Send a prompt to the desktop task with `send_message_to_thread`; wait/read through desktop tools.
4. Persist the role's `RESULT`, `BLOCKED`, or `QUESTION` with `message_send`, and acknowledge consumed inbox items with `message_ack`.

Use `task_upsert`/`task_graph` for coordination, `role_state_put` for durable role facts, and change envelopes for writable workers. Long-lived governance roles should normally be read-only; disposable implementation workers may write within a bounded envelope.

## Generation replacement

`role_attach` is the normal lifecycle operation. Supplying the current task id is idempotent. Supplying a new task id validates local authoritative state, retires the old generation, and activates the new one atomically. There is no task recovery state machine.

Advanced external drivers may use `rotation_prepare`, `rotation_candidate_register`, and `rotation_cutover`, but ordinary desktop orchestration should use `role_attach`.

Retired and rejected generations cannot continue. Before compaction, handoff, replacement, or completion, checkpoint durable state. Current user instructions, repository `AGENTS.md`, accepted ADRs, and fresh verification outrank stored role state.
