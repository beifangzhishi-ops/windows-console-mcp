[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$watchdogScript = Join-Path $PSScriptRoot 'diagnostics-watchdog.ps1'
$stateDir = Join-Path $repoRoot '.state'
$launcher = Join-Path $stateDir 'diagnostics-watchdog-hidden.vbs'
$taskName = 'WCM Diagnostics Watchdog'

if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) {
  throw "Watchdog script not found: $watchdogScript"
}

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$escaped = $watchdogScript.Replace('"','""')
@"
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escaped""", 0, True)
WScript.Quit rc
"@ | Set-Content -LiteralPath $launcher -Encoding ASCII

# WScript starts PowerShell without allocating a visible console. Windows Task
# Scheduler's own Hidden setting and PowerShell -WindowStyle Hidden are not enough.
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$launcher`""
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  # Preserve the existing trigger, account, settings and task identity.
  Set-ScheduledTask -TaskName $taskName -Action $action | Out-Null
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
}

Write-Output "Installed hidden-start task: $taskName"
