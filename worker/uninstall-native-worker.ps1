[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DeviceId,
    [string]$TaskName=''
)
$ErrorActionPreference='Stop'
if($DeviceId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'){ throw 'Invalid DeviceId.' }
if(-not $TaskName){ $TaskName="Windows Console Native Worker - $DeviceId" }
$workerDir=$PSScriptRoot
$repoRoot=Split-Path -Parent $workerDir
$safeId=$DeviceId -replace '[^A-Za-z0-9._-]','-'
$stateDir=Join-Path $repoRoot '.state'
$envFile=Join-Path $repoRoot ("config\worker-native-{0}.env" -f $DeviceId)
$supervisor=Join-Path $workerDir 'native-worker-supervisor.ps1'
$agent=Join-Path $workerDir 'agent.mjs'

function StopOwnedProcess([string]$PidFile,[string]$ExpectedPath){
    if(-not (Test-Path -LiteralPath $PidFile)){ return }
    $pidValue=0
    if(-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(),[ref]$pidValue)){ return }
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
    if($null -eq $proc){ return }
    $command=[string]$proc.CommandLine
    if($command.IndexOf($ExpectedPath,[StringComparison]::OrdinalIgnoreCase) -lt 0){
        Write-Warning "Skipping stale PID $pidValue because it is not owned by this native worker."
        return
    }
    & "$env:WINDIR\System32\taskkill.exe" /PID $pidValue /T /F *> $null
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
$supervisorPidFile=Join-Path $stateDir ("native-worker-{0}-supervisor.pid" -f $safeId)
$agentPidFile=Join-Path $stateDir ("native-worker-{0}-agent.pid" -f $safeId)
StopOwnedProcess $supervisorPidFile $supervisor
StopOwnedProcess $agentPidFile $agent
if(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue){
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Remove-Item -LiteralPath (Join-Path $stateDir ("native-worker-{0}-hidden.vbs" -f $safeId)),$supervisorPidFile,$agentPidFile,$envFile -Force -ErrorAction SilentlyContinue
Write-Output ("Removed native worker task and local runtime state for device {0}." -f $DeviceId)
