[CmdletBinding()]
param()
$ErrorActionPreference='SilentlyContinue'
$repoRoot=Split-Path -Parent $PSScriptRoot
Write-Output '=== Windows Console local ==='
Get-NetTCPConnection -State Listen -LocalPort 18008,18009,18100,18101 |
    Select-Object LocalAddress,LocalPort,OwningProcess |
    Sort-Object LocalPort |
    Format-Table -AutoSize | Out-String | Write-Output
Write-Output '=== Router / devices ==='
try {
    $health=Invoke-RestMethod 'http://127.0.0.1:18009/health' -TimeoutSec 3
    Write-Output ("router: {0}; default={1}" -f $health.status,$health.defaultDeviceId)
    @($health.devices) | ForEach-Object {
        Write-Output ("{0}: online={1}; local={2}; name={3}" -f $_.deviceId,$_.online,$_.local,$_.name)
    }
} catch { Write-Output 'router health: unavailable' }
Write-Output '=== OAuth sidecar ==='
try {
    $side=Invoke-RestMethod 'http://127.0.0.1:18008/health' -TimeoutSec 3
    Write-Output ("sidecar: {0}; issuer={1}" -f $side.status,$side.issuer)
} catch { Write-Output 'sidecar health: unavailable' }
Write-Output '=== Scheduled task ==='
$task=Get-ScheduledTask -TaskName 'Desktop Commander Selfhost Gateway'
if($task){ Write-Output ("Desktop Commander Selfhost Gateway: {0}" -f $task.State) }
else { Write-Output 'Desktop Commander Selfhost Gateway: missing' }
Write-Output '=== Tailscale ==='
$ts=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if(Test-Path $ts){
    $tailIp=[string](& $ts ip -4 2>$null | Select-Object -First 1)
    if($tailIp){ Write-Output ("controller Tailscale IPv4: {0}; remote worker port: 18100" -f $tailIp) }
    Write-Output '--- Funnel /rdc routes ---'
    & $ts funnel status 2>&1 |
        ForEach-Object { [string]$_ } |
        Where-Object { $_ -match '/rdc(?:/|\b)' } |
        Write-Output
}
Write-Output '=== Recent supervisor log ==='
Get-Content (Join-Path $repoRoot 'logs\rdc-supervisor.log') -Tail 15
