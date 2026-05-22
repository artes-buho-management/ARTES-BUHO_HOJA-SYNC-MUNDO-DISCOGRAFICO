param(
  [string]$TaskName = "Codex-SheetWatch-1VI74M"
)

$ErrorActionPreference = "Stop"
$repoPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $repoPath "run-gas-watch.ps1"
$xmlPath = Join-Path $repoPath "watch-task.xml"
$user = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path -LiteralPath $runner)) {
  throw "No se encontro $runner"
}

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>$((Get-Date).ToString('s'))</Date>
    <Author>$user</Author>
    <Description>Inicia clasp push --watch al iniciar sesion para hoja 1VI74M.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "$runner" -RepoPath "$repoPath"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

Set-Content -Path $xmlPath -Value $xml -Encoding Unicode

$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
}
finally {
  $ErrorActionPreference = $prev
}

schtasks /Create /TN $TaskName /XML $xmlPath /F | Out-Null

Write-Host "Tarea creada: \\$TaskName"
Write-Host "Runner: $runner"
Write-Host "Trigger: al iniciar sesion"
