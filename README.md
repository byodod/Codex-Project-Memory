# Codex Project Memory

这个仓库开发一款面向 Codex 长编程任务的本地项目记忆插件。它通过 SQLite FTS5、生命周期 Hooks 和 MCP 工具保存可恢复的任务状态、带来源的工程记忆、失败经验、验证证据与压缩前检查点。

项目现在只包含记忆能力，不再包含角色编排、协调者、联络者、角色任务图或会话绑定。

## 安装

```powershell
cd .\codex-project-memory
npm ci
npm test
.\scripts\install.ps1
```

安装完成后重启 Codex，在新任务中通过 `/hooks` 检查并信任插件 Hooks。

项目记忆会在 `PreCompact` 保存任务检查点，并在压缩后的 `SessionStart(source=compact)` 立即重新注入任务快照和精选记忆。它不会把完整历史常驻到模型上下文，也不需要 API Key。

## 清除当前项目记忆

在 Codex 输入框键入 `/`，选择 **Reset Project Memory**（技能名 `reset-project`）。该命令只会在用户明确执行时触发，并通过两次相同的项目根目录校验，删除该项目的任务、记忆、事件、验证记录、检查点和导出文件。

也可以直接调用 CLI：

```powershell
$projectRoot = "E:\Github\example\project"
node --no-warnings "$env:USERPROFILE\plugins\codex-project-memory\dist\cli.mjs" reset-project --cwd $projectRoot --confirm-root $projectRoot
```

清除操作无法由插件撤销。完成后新建 Codex 任务即可从零建立该项目的记忆。

## 参考与致谢

本项目面向 Codex 独立实现，记忆功能的设计研究参考了以下开源智能体项目，但没有直接包含或复制其源代码：

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)：持久化学习、经验沉淀为技能以及跨会话检索。
- [OpenClaw](https://github.com/openclaw/openclaw)：文件化长期记忆、记忆检索以及压缩前主动保存上下文。

## 许可证

本项目采用 [MIT License](./codex-project-memory/LICENSE)。
