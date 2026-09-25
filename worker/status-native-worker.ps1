[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DeviceId,
    [string]$TaskName=''
)
$ErrorActionPreference='Stop'
if($DeviceId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'){ throw 'Invalid DeviceId.' }
if(-not $TaskName){ $TaskName="Windows Console Native Worker - $DeviceId" }
$repoRoot=Split-Path -Parent $PSScriptRoot
$safeId=$DeviceId -replace '[^A-Za-z0-9._-]','-'
$stateDir=Join-Path $repoRoot '.state'
$logDir=Join-Path $repoRoot 'logs'
Write-Output '=== Scheduled task ==='
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($task){
    $task | Select-Object TaskName,State | Format-Table -AutoSize
    Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object LastRunTime,LastTaskResult,NextRunTime | Format-List
} else { Write-Output 'Not installed.' }
Write-Output '=== PID state ==='
foreach($kind in @('supervisor','agent')){
    $file=Join-Path $stateDir ("native-worker-{0}-{1}.pid" -f $safeId,$kind)
    if(Test-Path -LiteralPath $file){
        $pidValue=[int](Get-Content -LiteralPath $file -Raw)
        $proc=Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        Write-Output ("{0}: pid={1}; running={2}" -f $kind,$pidValue,($null -ne $proc))
    } else { Write-Output ("{0}: no pid file" -f $kind) }
}
Write-Output '=== Recent supervisor log ==='
Get-Content -LiteralPath (Join-Path $logDir ("native-worker-{0}-supervisor.log" -f $safeId)) -Tail 20 -ErrorAction SilentlyContinue
Write-Output '=== Recent agent stdout ==='
Get-Content -LiteralPath (Join-Path $logDir ("native-worker-{0}-stdout.log" -f $safeId)) -Tail 20 -ErrorAction SilentlyContinue
Write-Output '=== Recent agent stderr ==='
Get-Content -LiteralPath (Join-Path $logDir ("native-worker-{0}-stderr.log" -f $safeId)) -Tail 20 -ErrorAction SilentlyContinue
