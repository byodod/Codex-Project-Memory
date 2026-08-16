# Codex Role Runtime

This directory is the independently tested role-orchestration source component. Users normally install the unified `codex-project-memory` plugin from the sibling directory.

Role Runtime keeps persistent role identity, semantic ownership, typed mailboxes, task graphs, policies, and replaceable task generations in SQLite. Codex desktop owns task creation, lookup, messaging, waiting, archiving, and model execution.

The boundary is intentionally small:

- Hooks initialize role definitions, bind the current task as `role://liaison`, restore compact anchors, and enforce stale-generation/tool policy.
- MCP persists role state and returns desktop task ids and prompts.
- The LLM calls Codex desktop task tools directly.
- The runtime never starts Codex CLI or App Server and never hides model turns inside MCP calls.

## Core model

```text
User ↔ Liaison task
          │ durable request/result
          ▼
     Coordinator task ──> internal role tasks
          │
          └─ RoleStore / SQLite

Codex desktop tools: list/create/read/send/wait
Role Runtime MCP: persist/attach/route/checkpoint
```

Core invariants:

1. A role has at most one active generation.
2. A task's role binding never changes.
3. Messages address `role://...`, not task ids.
4. Stale generations and architecture epochs cannot author authoritative results.
5. Attaching a replacement task retires the prior generation atomically.

## Development

Requirements: Node.js 22.5 or newer.

```powershell
cd .\codex-role-runtime
npm ci
npm test
npm run pack:check
```

## One-prompt initialization

After plugin installation, open a project task and send:

```text
初始化角色编排
```

The Hook creates Liaison, Coordinator, Architect, and Verifier definitions and binds the current task as Liaison. During that same turn the Liaison model uses desktop `list_projects`, `list_threads`/`read_thread`, and `create_thread` as needed, then calls `role_attach` for the Coordinator.

For a project task, `projectId` is passed only as `target.projectId`; it is not also passed at the top level of `create_thread`. Persistent roles use the saved project's local checkout. A queued `clientThreadId` is never attached or treated as a failure: the model waits for the same task's real `threadId` instead of creating a duplicate or falling back to a fork.

If a stored task is missing, archived, deleted, or unavailable, the model creates a new task and calls `role_attach`. The old generation becomes retired; it is not recovered or resurrected.

## Request flow

1. `liaison_request` persists intent and returns the Coordinator task id and prompt.
2. The LLM uses desktop `send_message_to_thread`, `wait_threads`, and optionally `read_thread`.
3. `liaison_result` persists exactly one result and acknowledges the request.
4. The Liaison translates it for the user.

Internal `message_send` follows the same pattern: persist first, use the returned recipient task id with desktop tools, then persist the typed outcome.

## MCP surface

| Area | Tools |
|---|---|
| Project / status | `status`, `project_initialize`, `project_configure`, `architecture_advance` |
| Roles / state | `role_define`, `role_list`, `role_bind`, `role_attach`, `role_context_get`, `role_state_put`, `role_state_list` |
| Work graph | `task_upsert`, `task_graph`, `change_envelope_create`, `change_envelope_check` |
| Typed communication | `liaison_request`, `liaison_result`, `message_send`, `message_inbox`, `message_ack` |
| Advanced rotation | `rotation_prepare`, `rotation_candidate_register`, `rotation_cutover` |

The local CLI is inspection/state-only: `init`, `status`, `doctor`, `bind`, `attach`, and `context`. It does not create, query, open, resume, or run Codex tasks.

## License

Released under the [MIT License](./LICENSE).
