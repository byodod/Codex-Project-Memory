---
name: role-runtime
description: Initialize and operate persistent Codex project roles together with durable project memory. Use for role orchestration, a User Liaison or Coordinator, semantic ownership, typed routing, task graphs, role permissions, or attaching and replacing desktop task generations. Do not use for short work that needs neither persistent roles nor durable project state.
---

# Integrated Role Runtime

Use `role_runtime` for role identity, routing, ownership, mailboxes, policies, and task-generation bindings. Use `project_memory` for the user-level goal, acceptance criteria, durable decisions, failures, verification, and resumable next steps. They are one workflow, but their task ids remain separate namespaces.

Codex desktop task tools are the only task transport. The Role Runtime MCP stores state; it never queries, creates, resumes, archives, or runs Codex tasks and never invokes Codex CLI or App Server.

## Desktop task transport contract

Treat these desktop calls as exact argument whitelists:

```js
list_projects({})
list_threads({ limit: 50 })

create_thread({
  target: {
    type: "project",
    projectId,
    environment: { type: "local" }
  },
  prompt,
  title
})

read_thread({
  threadId,
  hostId,
  includeOutputs: true,
  turnLimit: 5,
  maxOutputCharsPerItem: 12000
})

send_message_to_thread({
  threadId,
  hostId,
  prompt
})

wait_threads({
  targets: [{ threadId, hostId }],
  timeoutMs: 120000
})
```

Call `list_projects({})` first and use the `projectId` whose normalized project path equals the current project root. `projectId` belongs only at `create_thread.target.projectId`; never add a second top-level `projectId` beside `target`. Persistent roles use `local` so they share the live project checkout. Use a worktree only when the user explicitly requests isolation; then replace `environment` with `{ type: "worktree", startingState: { type: "working-tree" } }` without changing the location of `projectId`.

Search both `pinnedThreads` and `threads` from `list_threads`, match an existing binding by exact `threadId`, and carry its returned `hostId` into read/send/wait calls. `read_thread` accepts only `threadId`, optional `hostId`, `cursor`, `includeOutputs`, `maxOutputCharsPerItem`, and `turnLimit`. `send_message_to_thread` accepts only `threadId`, `prompt`, optional `hostId`, `model`, and `thinking`; its message field is named `prompt`, never `message`, `content`, `taskId`, `projectId`, or `target`.

Only set `model` and `thinking` on create/send when user or project instructions require them, and use the canonical model id exposed by the desktop tool, such as `gpt-5.6-luna` with `thinking: "max"`. If creation returns `threadId`, attach it. If it returns only `clientThreadId`, setup is pending: do not pass that value to read/send/wait/`role_attach`, do not call `create_thread` again, and do not fall back to `fork_thread`. Resolve the one pending task through `list_threads` until its real `threadId` and `hostId` are available, then attach it. After sending, wait with `wait_threads({ targets: [{ threadId, hostId }], timeoutMs })`; reuse any returned cursor as that target's `afterCursor` on a later wait.

## One-prompt initialization

When the user sends exactly `初始化角色编排`, `启动角色编排`, or `initialize role orchestration`, the Hook creates Liaison, Coordinator, Architect, and Verifier definitions and binds the current task as the sole user-facing Liaison. If another Liaison is active, the current task replaces it.

In that same model turn:

1. Call `role_runtime.status` and `project_memory.task_get` with the current `cwd`.
2. Use Codex desktop `list_projects` and `list_threads`/`read_thread` to inspect the attached Coordinator task.
3. If no Coordinator is attached, or its task is missing, archived, deleted, or unavailable, create one task using the exact desktop task transport contract above. Give it the Coordinator anchor and tell it to await routed work.
4. Call `role_runtime.role_attach` with the returned task id. Supplying a different id retires the old generation atomically.
5. Confirm Liaison and Coordinator readiness. Do not expose internal task ids unless debugging requires them.

Do not recover or resurrect an unavailable task. Create a replacement and attach it.

## Liaison to Coordinator

For each substantive request:

1. Clarify only material ambiguity.
2. Call `liaison_request` with a stable `message_id`. It persists the request and returns a Coordinator task id and prompt; it does not start a model turn.
3. If the recipient is `needs_task`, create a desktop task, call `role_attach`, and repeat `liaison_request` with the same id.
4. Use desktop `send_message_to_thread`, then `wait_threads` and optionally `read_thread`.
5. Call `liaison_result` exactly once to store the Coordinator response and acknowledge the request.
6. Relay the result to the user in concise language.

The Liaison does not implement, schedule, architect, or verify internal work. The Coordinator does not address the user directly.

## Coordinator operation

- Keep the Role Runtime task graph aligned with the Project Memory goal, acceptance criteria, completed items, blockers, and next steps.
- Persist internal traffic with `message_send`. It returns the recipient's desktop task id or `needs_task`; it never wakes a task itself.
- For a missing, archived, deleted, or unavailable role task, create exactly one replacement with the desktop task transport contract, wait for its real `threadId`, and call `role_attach`. Then use the exact send/wait/read shapes above.
- Store role charters and invariants with `role_state_put`; store reusable cross-role project facts with `project_memory.memory_store` using honest provenance.
- Give writable workers bounded change envelopes. Record meaningful test/build/review evidence with `verification_record`.
- Use a fresh Verifier generation when independence matters. Complete Project Memory only after criteria pass and blockers/next steps are empty.

`liaison_request.task_id` and `message_send.task_id` accept Role Runtime task-graph ids only. Carry a Project Memory task id in `payload.project_memory_task_id`.

## Generation lifecycle

Address roles as `role://<role-key>`, never by task id. A task belongs to one role for life, and only the active generation may send authoritative results. `role_attach` is idempotent for the current id; a new id validates authoritative local state, retires the old generation, and activates the new one. There is no task recovery state machine.

Retired and rejected generations cannot continue. Before compaction, handoff, replacement, or completion, update and checkpoint Project Memory. Current user instructions, repository `AGENTS.md`, accepted ADRs, and fresh verification outrank recalled history.
