param(
  [string]$RepoPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
  $RepoPath = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$claspLocal = Join-Path $RepoPath "node_modules\@google\clasp\build\src\index.js"
if (-not (Test-Path -LiteralPath $claspLocal)) {
  throw "No se encontro clasp local en $claspLocal"
}

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($candidate in @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe",
    "C:\Progra~1\nodejs\node.exe"
  )) {
    if (Test-Path -LiteralPath $candidate) {
      $nodeExe = $candidate
      break
    }
  }
}

if (-not $nodeExe) {
  throw "No se encontro node.exe"
}

Set-Location $RepoPath
& $nodeExe $claspLocal push --watch
