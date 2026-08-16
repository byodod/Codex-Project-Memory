$ErrorActionPreference = 'Stop'
$PluginRoot = Split-Path -Parent $PSScriptRoot
Push-Location $PluginRoot
try {
  npm ci
  npm test
  node .\scripts\install-local.mjs
} finally {
  Pop-Location
}
