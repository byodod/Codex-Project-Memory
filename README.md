# Codex Project Memory

Codex 原生的长任务项目记忆插件。源码位于 [`codex-project-memory/`](./codex-project-memory/README.md)。

它用本地 SQLite FTS5、Codex 生命周期 Hooks 和 MCP 工具保存可恢复的任务状态、带来源的工程记忆、工具事实与验证证据；不需要 API Key，也不会把完整历史常驻到模型上下文。

快速开始：

```powershell
cd .\codex-project-memory
npm ci
npm test
.\scripts\install.ps1
```

安装完成后重启 Codex，在新任务中通过 `/hooks` 信任插件 Hooks。
