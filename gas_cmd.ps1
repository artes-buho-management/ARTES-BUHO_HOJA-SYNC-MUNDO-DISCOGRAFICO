param(
  [ValidateSet("create", "login", "status", "pull", "push", "open", "version", "deploy", "run", "watch")]
  [string]$Action = "status",
  [string]$SheetId = "",
  [string]$Title = "Hoja Sync 1VI74M",
  [string]$FunctionName = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$claspLocal = Join-Path $repoRoot "node_modules\@google\clasp\build\src\index.js"

if (-not (Test-Path -LiteralPath $claspLocal)) {
  throw "No se encontro clasp local en $claspLocal. Ejecuta npm install."
}

function Resolve-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }

  $candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe",
    "C:\Progra~1\nodejs\node.exe",
    "C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  throw "No se encontro node.exe"
}

function Invoke-Clasp {
  param([string[]]$ClaspArgs)
  & $nodeExe $claspLocal @ClaspArgs
  if ($LASTEXITCODE -ne 0) {
    throw "clasp $($ClaspArgs -join ' ') fallo"
  }
}

$nodeExe = Resolve-NodeExe

switch ($Action) {
  "create" {
    if ([string]::IsNullOrWhiteSpace($SheetId)) {
      throw "Debes indicar -SheetId para crear y vincular el proyecto."
    }
    Invoke-Clasp -ClaspArgs @("create", "--type", "standalone", "--title", $Title, "--parentId", $SheetId)
  }
  "run" {
    if ([string]::IsNullOrWhiteSpace($FunctionName)) {
      throw "Debes indicar -FunctionName para -Action run."
    }
    Invoke-Clasp -ClaspArgs @("run", $FunctionName)
  }
  "watch" {
    Invoke-Clasp -ClaspArgs @("push", "--watch")
  }
  default {
    Invoke-Clasp -ClaspArgs @($Action)
  }
}
