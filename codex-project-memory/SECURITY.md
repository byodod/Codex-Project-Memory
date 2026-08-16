# Security and privacy

- All memory is local. The plugin makes no network requests and needs no API key.
- Runtime data is written beneath `PLUGIN_DATA`; standalone development defaults to `~/.codex-project-memory`.
- Tool inputs and responses are truncated and common secret formats and secret-bearing object keys are redacted before storage. Redaction is defense in depth, not a guarantee; do not intentionally print secrets into tool output.
- Hook recalls label provenance and explicitly state that memory is historical context. Only current user instructions and repository authority such as `AGENTS.md` or ADRs should be treated as authoritative.
- Archive is a soft delete. To remove data permanently, delete the plugin data directory while Codex is closed.
- The completion gate only runs for an active task with `gate_enabled: true`, and Codex's `stop_hook_active` prevents continuation loops.
