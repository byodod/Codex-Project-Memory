# Data model

Core tables:

- `projects`: repository/worktree identity, L0 constitution, architecture epoch.
- `roles`: immutable role key, mission, semantic ownership, exclusions, escalation rules, policy.
- `role_generations`: immutable role/thread binding, generation number, status, health, compaction and turn counts.
- `role_leases`: active generation and monotonically increasing lease epoch.
- `role_facts`: provenance-labelled structured L1 state with supersession.
- `tasks` and `task_dependencies`: task packets and dependency graph.
- `messages`: typed role mailbox with generation and architecture-epoch fencing.
- `change_envelopes`: intent versus allowed/actual scope and verification requirements.
- `rotations`: crash-recoverable state machine and authoritative checkpoint.
- `events`: idempotent Hook and runtime observations.

Database constraints enforce a unique active generation per role, a unique thread id globally, one bootstrapping candidate per role, immutable generation bindings, unique role keys per project, and idempotent message/event ids.
