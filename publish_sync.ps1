param(
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$hasChanges = $false
git diff --quiet
if ($LASTEXITCODE -ne 0) { $hasChanges = $true }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { $hasChanges = $true }

if ($hasChanges) {
  git add -A
  if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "chore: sync updates $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  }
  git commit -m $Message
} else {
  Write-Host "No hay cambios locales para commit."
}

git push origin main
powershell -NoProfile -ExecutionPolicy Bypass -File .\gas_cmd.ps1 -Action push

