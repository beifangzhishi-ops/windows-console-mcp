[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$stateDir=Join-Path $repoRoot '.state'
$supervisor=Join-Path $repoRoot 'scripts\rdc-supervisor.ps1'
$vbs=Join-Path $stateDir 'rdc-supervisor-hidden.vbs'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$escaped=$supervisor.Replace('"','""')
@"
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$escaped""", 0, True)
WScript.Quit rc
"@ | Set-Content -LiteralPath $vbs -Encoding ASCII
$action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$vbs`""
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay='PT1M'
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Desktop Commander Selfhost Gateway' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output 'Installed scheduled task: Desktop Commander Selfhost Gateway'
