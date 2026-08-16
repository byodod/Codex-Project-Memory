---
name: reset-project
description: Permanently clear the current project's complete Codex Project Runtime state, including Project Memory records and exports plus Role Runtime roles, generations, tasks, messages, rotations, events, and change envelopes. Use only when the user explicitly invokes this reset skill or clearly asks to make the current project start from zero. Never invoke implicitly for ordinary cleanup, task completion, or partial memory deletion.
---

# Reset Project Runtime

Treat selecting this skill as a destructive request only when the submitted prompt explicitly asks to clear or reset the current project. Otherwise, explain the effect without changing data.

1. Resolve the target through the stable installed CLI. Run this read-only PowerShell first:

   ```powershell
   $pluginCli = Join-Path $env:USERPROFILE 'plugins\codex-project-memory\dist\cli.mjs'
   if (-not (Test-Path -LiteralPath $pluginCli -PathType Leaf)) { throw "Codex Project Runtime is not installed at $pluginCli" }
   $currentDirectory = (Get-Location).Path
   $status = (& node --no-warnings $pluginCli status --cwd $currentDirectory | ConvertFrom-Json)
   $projectRoot = (Resolve-Path -LiteralPath $status.project.root).Path
   ```

2. State the exact `$projectRoot` and that the reset cannot be undone in a concise commentary update.
3. Run exactly:

   ```powershell
   node --no-warnings $pluginCli reset-project --cwd $projectRoot --confirm-root $projectRoot
   ```

   Use the resolved `project.root` for both arguments. Do not substitute a parent directory, wildcard, unresolved environment variable, or manually constructed path. Do not delete files or databases directly.
4. Parse the command's JSON response. Require `ok: true` and `root` equal to `$projectRoot`. Report the Project Memory and Role Runtime deletion counts.
5. After success, do not call Project Memory or Role Runtime tools for that project in the same task because doing so can recreate state. Tell the user to start a new Codex task and send `初始化角色编排` when they want a fresh role topology.

Existing Codex tasks can remain visible in task history, but they no longer have durable Project Runtime state or role authority after this reset.
