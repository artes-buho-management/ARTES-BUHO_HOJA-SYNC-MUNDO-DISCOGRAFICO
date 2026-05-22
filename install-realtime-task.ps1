param(
  [ValidateRange(1, 60)]
  [int]$IntervalMinutes = 1,
  [string]$TaskName = "Codex-SheetSync-1VI74M",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$repoPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $repoPath "sync-cycle.ps1"
$xmlPath = Join-Path $repoPath "autosync-task.xml"

if (-not (Test-Path -LiteralPath $runner)) {
  throw "No se encontro $runner"
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$start = (Get-Date).AddMinutes(1).ToString('s')
$interval = "PT${IntervalMinutes}M"

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>$((Get-Date).ToString('s'))</Date>
    <Author>$user</Author>
    <Description>AutoSync Apps Script + GitHub para hoja 1VI74M.</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <Repetition>
        <Interval>$interval</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </CalendarTrigger>
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
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "$runner" -RepoPath "$repoPath" -Branch "$Branch"</Arguments>
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
Write-Host "Intervalo: cada $IntervalMinutes minuto(s)"
Write-Host "Runner: $runner"
