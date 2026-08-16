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

## 参考与致谢

本项目的设计研究参考了以下开源智能体项目，但实现面向 Codex 独立完成，未直接包含它们的源代码：

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)：持久化学习、经验沉淀为技能以及跨会话检索的设计思路。
- [OpenClaw](https://github.com/openclaw/openclaw)：文件化长期记忆、记忆检索以及压缩前主动保存上下文的设计思路。

## 许可证

本项目采用 [MIT License](./codex-project-memory/LICENSE) 发布。
