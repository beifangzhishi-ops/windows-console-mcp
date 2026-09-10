[CmdletBinding()]
param()
$ErrorActionPreference='SilentlyContinue'
Stop-ScheduledTask -TaskName 'Desktop Commander Selfhost Gateway'
Unregister-ScheduledTask -TaskName 'Desktop Commander Selfhost Gateway' -Confirm:$false
$repoRoot=Split-Path -Parent $PSScriptRoot
Remove-Item (Join-Path $repoRoot '.state\rdc-supervisor-hidden.vbs') -Force
Write-Output 'Removed scheduled task: Desktop Commander Selfhost Gateway'
