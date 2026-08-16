# Architecture

Codex Role Runtime is a hybrid plugin and local control plane. Every entry point uses the same `RoleStore` and project identity resolver.

```text
Codex CLI / Desktop
  ├─ User ↔ Liaison ─> Coordinator dispatch
  ├─ lifecycle Hooks ─┐
  ├─ MCP tools ───────┼─> RoleStore ─> SQLite WAL
  └─ codex-role CLI ──┘      │
                              └─> AppServerClient ─> codex app-server
```

The durable control plane owns identity, state, policy, routing, tasks, messages, epochs, envelopes, leases, and rotation transactions. Codex owns model execution, top-level threads, native goals, subagents, authentication, and user interaction.

## User interaction boundary

`role://liaison` is the only role that converses with the user. An exact initialization prompt creates the standard topology, binds the current task as the Liaison, and lets the Liaison start the Coordinator with `role_start`. `liaison_request` persists the user request, wakes the active Coordinator generation through App Server, waits for its response, and persists that response back to the Liaison mailbox. The Coordinator routes internal work; internal roles never require direct user contact.

## Rotation transaction

The old generation remains `active` while the candidate is `bootstrapping`. After the health packet validates, one `BEGIN IMMEDIATE` transaction retires the old row, activates the candidate, and advances the lease epoch. SQLite partial unique indexes make dual-active roles impossible. A failed or crashed bootstrap leaves the active pointer untouched.

## Policy boundary

`PreToolUse` blocks stale generations and matches the role's denied-tool regexes. This is a strong guardrail but not the only enforcement boundary: `change_envelope_check` compares the actual changed path set against a task's explicit scope, and independent verification remains required.

## Context control

Hooks inject only a compact role anchor. Full state is fetched on demand through `role_context_get`; transcripts are never promoted wholesale into durable role truth.
