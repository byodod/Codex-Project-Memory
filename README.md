# Codex Runtime Tools

这个仓库开发两套互补的运行时组件，但对用户发布为一款统一的 Codex 插件：

- [Codex Project Runtime](./codex-project-memory/README.md)：最终安装包，整合项目记忆、用户联络者、内部协调者、角色任务图、权限策略和安全换代。
- [Role Runtime 源组件](./codex-role-runtime/README.md)：保留独立源码与测试，构建时自动打包进上面的统一插件，不再要求用户单独安装。

## 统一安装

它用本地 SQLite FTS5、Codex 生命周期 Hooks 和 MCP 工具保存可恢复的任务状态、带来源的工程记忆、工具事实与验证证据；不需要 API Key，也不会把完整历史常驻到模型上下文。

快速开始：

```powershell
cd .\codex-project-memory
npm ci
npm test
.\scripts\install.ps1
```

安装完成后重启 Codex，在新任务中通过 `/hooks` 信任插件 Hooks。

安装脚本会同时打包 Role Runtime，移除重复的独立角色插件安装，并保留已有角色数据库。Project Memory 保存用户级目标、决策、失败与验证证据；Role Runtime 保存内部角色身份、路由、任务图与 Generation 生命周期。

安装并重启 Codex 后，在项目的新任务中只需发送 `初始化角色编排`。当前任务会成为用户联络者，内部协调者由插件启动；协调者发出任务消息时会自动创建并唤醒目标角色任务，之后用户始终通过这个联络者沟通。

需要让某个项目彻底从零开始时，可执行以下破坏性命令。它只清除两次明确指定的同一项目根目录所对应的全部项目记忆、导出文件、角色、Generation、任务图、消息、轮换和事件；其他项目不受影响：

安装更新并新建 Codex 任务后，直接在输入框键入 `/`，选择 **Reset Project Runtime**（技能名 `reset-project`）即可。Codex 会把已启用技能显示在斜杠命令列表中；该技能禁止隐式触发，只会在用户明确选择并提交清除请求时运行。它会自动解析当前项目根目录，并调用下方带双重根目录校验的 CLI 执行实际清除。

```powershell
$projectRoot = "E:\Github\4.6\Game-10"
node --no-warnings "$env:USERPROFILE\plugins\codex-project-memory\dist\cli.mjs" reset-project --cwd $projectRoot --confirm-root $projectRoot
```

清除不可由插件撤销。完成后新建 Codex 任务，再发送 `初始化角色编排`。

## 参考与致谢

本项目的设计研究参考了以下开源智能体项目，但实现面向 Codex 独立完成，未直接包含它们的源代码：

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)：持久化学习、经验沉淀为技能以及跨会话检索的设计思路。
- [OpenClaw](https://github.com/openclaw/openclaw)：文件化长期记忆、记忆检索以及压缩前主动保存上下文的设计思路。

## 许可证

统一插件及其 Role Runtime 源组件均采用 MIT License 发布：

- [Codex Project Memory License](./codex-project-memory/LICENSE)
- [Codex Role Runtime License](./codex-role-runtime/LICENSE)
