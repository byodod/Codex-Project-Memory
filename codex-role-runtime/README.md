# Codex Role Runtime

Codex Role Runtime is a local Codex plugin for **persistent roles over replaceable thread generations**. It keeps role identity, semantic ownership, task state, typed messages, architecture epochs, and verification envelopes outside the model context, so an aging or repeatedly compacted Codex thread can be retired without losing the role.

The implementation is Codex-native:

- Hooks restore a compact role anchor, reject retired generations, enforce role tool policy, and track compaction health.
- MCP exposes the durable Role / Generation / Task / Message / Ownership / Rotation control plane.
- SQLite provides atomic cutover, idempotency, crash recovery, and hard invariants.
- The CLI creates and resumes top-level Codex threads through App Server and performs structured bootstrap health checks.
- Native Codex subagents remain the right execution mechanism for disposable workers; the runtime does not replace them.

No OpenAI API key is required. Codex App Server uses the user's existing Codex authentication.

## Core model

```text
Persistent Project
  └─ Persistent Role (role://architect)
       ├─ Structured Role State
       ├─ Typed Mailbox
       ├─ Task / Ownership / Architecture Epoch
       └─ Current Generation
            └─ Replaceable Codex Thread
```

Five invariants are enforced:

1. A role has at most one active generation.
2. A thread's role binding never changes.
3. Persistent messages are addressed to `role://...`, not stored thread ids.
4. Results from a non-active generation or stale architecture epoch are rejected.
5. A candidate is validated before an atomic cutover; failure leaves the old generation active.

## Install

Requirements: Node.js 22.5 or newer and the Codex CLI.

```powershell
cd .\codex-role-runtime
npm ci
npm test
.\scripts\install.ps1
```

The installer builds the bundle, copies it to `~/plugins/codex-role-runtime`, adds it to the personal marketplace, installs it in Codex, and places durable data under `~/.codex/plugin-data/codex-role-runtime`.

Restart Codex, open a new task, and review/trust the plugin hooks with `/hooks`.

## First project

Create the standard governance topology:

```powershell
node "$HOME\plugins\codex-role-runtime\dist\cli.mjs" init --cwd C:\path\to\project
```

This creates three intentionally narrow, read-only long-lived roles:

- `role://coordinator` — project goal, task graph, dependencies, routing, milestones, blockers.
- `role://architect` — architecture, semantic ownership, dependency direction, cross-module contracts.
- `role://verifier` — fresh independent acceptance, architecture consistency, diff-versus-intent, test evidence.

Add Module Owners only for real bounded contexts. Use short-lived `workspace_write` workers for implementation.

## Bind, start, and rotate

To bind the current ordinary Codex task as generation 1, send this exact prompt after the role exists:

```text
role://bind coordinator
```

To let the runtime create a fresh top-level thread through Codex App Server:

```powershell
node "$HOME\plugins\codex-role-runtime\dist\cli.mjs" start architect --cwd C:\path\to\project
```

Rotate an aging role safely:

```powershell
node "$HOME\plugins\codex-role-runtime\dist\cli.mjs" rotate architect `
  --cwd C:\path\to\project `
  --reason "milestone complete"
```

Open the active generation later:

```powershell
node "$HOME\plugins\codex-role-runtime\dist\cli.mjs" open architect --cwd C:\path\to\project
```

Rotation follows:

```text
ROTATION_PENDING → DRAINING → CHECKPOINTING → VALIDATING
→ BOOTSTRAPPING → CUTOVER → COMPLETED
```

The new thread first returns a structured health packet. The runtime compares its role id, mission, owned domains, critical invariants, open questions, and architecture epoch with SQLite. Only a match permits cutover.

## MCP surface

| Area | Tools |
|---|---|
| Project / status | `status`, `project_configure`, `architecture_advance` |
| Roles / state | `role_define`, `role_list`, `role_bind`, `role_context_get`, `role_state_put`, `role_state_list` |
| Work graph | `task_upsert`, `task_graph`, `change_envelope_create`, `change_envelope_check` |
| Typed communication | `message_send`, `message_inbox`, `message_ack` |
| Rotation adapters | `rotation_prepare`, `rotation_candidate_register`, `rotation_cutover` |

Typed messages support `ASSIGN`, `QUESTION`, `ANSWER`, `PROPOSAL`, `DECISION_REQUEST`, `DECISION`, `HANDOFF`, `VERIFY_REQUEST`, `RESULT`, and `BLOCKED`.

## Context layers

- L0 — project constitution: short global goals, principles, non-goals, and dependency rules.
- L1 — role charter and structured facts: ownership, accepted decisions, invariants, failures, dependencies, artifacts.
- L2 — active task packet and change envelope.
- L3 — disposable thread context: tool output, logs, temporary hypotheses, and local reasoning.

Only L3 is expected to die during generation rotation.

## Current Codex boundary

The local Codex CLI reports App Server as experimental in version `0.147.0`, although its protocol documents `thread/start`, `turn/start`, thread goals, generated schemas, and streamed completion events. The runtime isolates this behind `AppServerClient`; SQLite state, MCP, Hooks, and all core invariants do not depend on the transport implementation. If the App Server bootstrap fails, no active-generation pointer is changed.

Official references:

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [Codex Plugins](https://developers.openai.com/codex/plugins)

## Development

```powershell
npm test
npm run pack:check
npm run doctor
```

See [architecture.md](./docs/architecture.md) and [data-model.md](./docs/data-model.md).

## License

Released under the [MIT License](./LICENSE).
