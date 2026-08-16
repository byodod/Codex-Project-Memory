# Codex Runtime Tools

这个仓库包含两款互补的 Codex 原生插件：

- [Codex Project Memory](./codex-project-memory/README.md)：保存跨压缩、恢复和交接的项目任务记忆、工程事实与验证证据。
- [Codex Role Runtime](./codex-role-runtime/README.md)：让持久角色独立于可替换会话，提供角色固定、typed mailbox、任务图、权限策略和安全换代。

## Project Memory

它用本地 SQLite FTS5、Codex 生命周期 Hooks 和 MCP 工具保存可恢复的任务状态、带来源的工程记忆、工具事实与验证证据；不需要 API Key，也不会把完整历史常驻到模型上下文。

快速开始：

```powershell
cd .\codex-project-memory
npm ci
npm test
.\scripts\install.ps1
```

安装完成后重启 Codex，在新任务中通过 `/hooks` 信任插件 Hooks。

## Role Runtime

```powershell
cd .\codex-role-runtime
npm ci
npm test
.\scripts\install.ps1
```

Role Runtime 把 `Project / Role / Responsibility / State` 作为长期实体，把 Codex Thread 作为可退休、可替换的 Generation。它通过 SQLite 硬约束、MCP、Hooks 和 Codex App Server 实现角色路由、旧代拒绝、压缩健康和原子换代。

## 参考与致谢

本项目的设计研究参考了以下开源智能体项目，但实现面向 Codex 独立完成，未直接包含它们的源代码：

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)：持久化学习、经验沉淀为技能以及跨会话检索的设计思路。
- [OpenClaw](https://github.com/openclaw/openclaw)：文件化长期记忆、记忆检索以及压缩前主动保存上下文的设计思路。

## 许可证

两个插件均采用 MIT License 发布：

- [Codex Project Memory License](./codex-project-memory/LICENSE)
- [Codex Role Runtime License](./codex-role-runtime/LICENSE)
