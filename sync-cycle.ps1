param(
  [string]$RepoPath = "",
  [string]$Branch = "main",
  [switch]$SkipDown
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
  $RepoPath = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$syncTool = Join-Path $RepoPath "..\..\03_SCRIPTS_UTILIDAD\sync_git_gas.ps1"
if (-not (Test-Path -LiteralPath $syncTool)) {
  throw "No se encontro sync_git_gas.ps1 en $syncTool"
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "[SYNC-CYCLE] Inicio $timestamp"

if (-not $SkipDown) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $syncTool -Action down -RepoPath $RepoPath -Branch $Branch -AllowDirty
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[SYNC-CYCLE] Aviso: down devolvio codigo $LASTEXITCODE. Continuo con up."
  }
}

$msg = "auto-sync hoja 1VI74M " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
& powershell -NoProfile -ExecutionPolicy Bypass -File $syncTool -Action up -RepoPath $RepoPath -Branch $Branch -CommitMessage $msg

if ($LASTEXITCODE -ne 0) {
  throw "sync up fallo con codigo $LASTEXITCODE"
}

Write-Host "[SYNC-CYCLE] Fin OK"
