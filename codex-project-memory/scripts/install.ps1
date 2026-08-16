$ErrorActionPreference = 'Stop'
$PluginRoot = Split-Path -Parent $PSScriptRoot
node (Join-Path $PluginRoot 'scripts\install-local.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
