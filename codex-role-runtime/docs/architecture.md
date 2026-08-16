# Architecture

Every entry point uses the same `RoleStore` and project resolver.

```text
Codex Desktop LLM
  ├─ task tools: list / create / read / send / wait
  ├─ lifecycle Hooks ─┐
  └─ MCP tools ───────┼─> RoleStore ─> SQLite WAL
      state-only CLI ─┘
```

The durable control plane owns role identity, state, policy, typed routing, task graphs, epochs, envelopes, leases, and atomic generation attachment. Codex desktop owns task existence, lifecycle, execution, authentication, and user interaction.

## User interaction boundary

`role://liaison` is the only role that converses with the user. An exact initialization prompt creates the standard topology and binds the current task as Liaison. The Liaison model directly finds or creates the Coordinator desktop task and records its id with `role_attach`.

`liaison_request` only persists intent and prepares a prompt. Desktop tools perform send/wait/read. `liaison_result` persists the returned response. No MCP call starts a hidden model turn.

If an attached task is missing, archived, deleted, or unavailable, the model creates a replacement and calls `role_attach`; the old generation is retired without a recovery state machine.

## Atomic attachment

When a new task id is attached, the previous generation remains active while the candidate is locally validated. One transaction then retires the old row, activates the candidate, and advances the lease epoch. SQLite partial unique indexes prevent dual-active roles.

## Policy and context

Hooks inject only compact role anchors. `PreToolUse` blocks stale generations and denied tools. Full state is fetched on demand through `role_context_get`; transcripts are never promoted wholesale into durable truth.
