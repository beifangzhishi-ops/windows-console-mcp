[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $repoRoot '.state'
$logDir = Join-Path $repoRoot 'logs'
$configFile = Join-Path $repoRoot 'config\rdc.env'
$devicesFile = Join-Path $repoRoot 'config\devices.json'
if(-not (Test-Path $devicesFile)){ throw "Missing runtime file: $devicesFile" }
$registry = Get-Content -LiteralPath $devicesFile -Raw | ConvertFrom-Json
$localDevice = @($registry.devices | Where-Object { $_.local -eq $true -and $_.enabled -ne $false }) | Select-Object -First 1
if(-not $localDevice){ throw 'config\devices.json does not define an enabled local device.' }
$localDeviceId = [string]$localDevice.deviceId
$workerEnv = Join-Path $repoRoot ("config\worker-{0}.env" -f $localDeviceId)
$workerPidFile = Join-Path $stateDir ("rdc-worker-{0}.pid" -f $localDeviceId)
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$router = Join-Path $repoRoot 'router\server.mjs'
$worker = Join-Path $repoRoot 'worker\agent.mjs'
$sidecar = Join-Path $repoRoot 'rdc-sidecar\server.mjs'
$supervisorLog = Join-Path $logDir 'rdc-supervisor.log'
New-Item -ItemType Directory -Force -Path $stateDir,$logDir | Out-Null
foreach($p in @($configFile,$devicesFile,$workerEnv,$router,$worker,$sidecar)){
    if(-not (Test-Path $p)){ throw "Missing runtime file: $p" }
}
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\DesktopCommanderSelfhostGateway', [ref]$createdNew)
if (-not $createdNew) { $mutex.Dispose(); exit 0 }
$selfInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$launcherPid = [int]$selfInfo.ParentProcessId
$launcherInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$launcherPid" -ErrorAction SilentlyContinue
$watchLauncher = $null -ne $launcherInfo -and $launcherInfo.Name -ieq 'wscript.exe'
function LauncherAlive { if(-not $watchLauncher){ return $true }; return $null -ne (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue) }
function Log([string]$m){ "[$(Get-Date -Format s)] $m" | Out-File $supervisorLog -Encoding utf8 -Append }
function Listener([int]$port){ Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1 }
function WaitPort([int]$port,[int]$seconds){
    for($i=0;$i -lt ($seconds*4);$i++){
        if(Listener $port){return $true}
        Start-Sleep -Milliseconds 250
    }
    return $false
}
function StartHidden([string]$file,[string]$arguments){
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    $psi.Arguments = $arguments
    $psi.WorkingDirectory = $repoRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    if(-not $proc.Start()){ throw "Failed to start $file" }
    return $proc
}
function StopTree($proc){
    if($null -ne $proc -and -not $proc.HasExited){ & taskkill.exe /PID $proc.Id /T /F *> $null }
}
function WaitLocalWorker([int]$seconds){
    for($i=0;$i -lt ($seconds*2);$i++){
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18009/health' -TimeoutSec 2
            $online = @($health.devices | Where-Object { $_.deviceId -eq $localDeviceId -and $_.online -eq $true })
            if($online.Count -gt 0){ return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}
try {
    while($true){
        if(-not (LauncherAlive)){ return }
        $routerProc=$null; $workerProc=$null; $side=$null
        try {
            if(-not (Test-Path $tailscale)){ throw 'Tailscale is required for the remote worker listener.' }
            $tailIp = [string](& $tailscale ip -4 2>$null | Select-Object -First 1)
            $tailIp = $tailIp.Trim()
            if(-not $tailIp){ throw 'Tailscale IPv4 was unavailable.' }
            $env:WC_WORKER_REMOTE_HOST = $tailIp
            $env:WC_WORKER_REMOTE_PORT = '18100'
            foreach($port in @(18009,18101,18100,18008)){
                if(Listener $port){ throw "Port $port is already in use; refusing to claim it." }
            }
            Remove-Item (Join-Path $stateDir 'rdc-upstream-session.json') -Force -ErrorAction SilentlyContinue
            $routerProc = StartHidden $node "`"$router`""
            Set-Content (Join-Path $stateDir 'rdc-router.pid') $routerProc.Id -Encoding ASCII
            if(-not (WaitPort 18009 20)){ throw 'Windows Console router did not listen on 18009.' }
            if(-not (WaitPort 18101 10)){ throw 'Worker hub did not listen on 18101.' }
            if(-not (WaitPort 18100 10)){ throw 'Remote Tailscale worker hub did not listen on 18100.' }
            $workerProc = StartHidden $node "`"$worker`" `"$workerEnv`""
            Set-Content $workerPidFile $workerProc.Id -Encoding ASCII
            if(-not (WaitLocalWorker 20)){ throw "Local worker $localDeviceId did not register with the router." }
            $side = StartHidden $node "`"$sidecar`""
            Set-Content (Join-Path $stateDir 'rdc-sidecar.pid') $side.Id -Encoding ASCII
            if(-not (WaitPort 18008 10)){ throw 'RDC OAuth sidecar did not listen on 18008.' }
            Log "ready router=$($routerProc.Id) worker=$($workerProc.Id) sidecar=$($side.Id)"
            while(-not $routerProc.HasExited -and -not $workerProc.HasExited -and -not $side.HasExited){
                if(-not (LauncherAlive)){ Log 'scheduled-task launcher exited'; return }
                Start-Sleep -Seconds 2
            }
            Log "child exited routerExit=$($routerProc.HasExited) workerExit=$($workerProc.HasExited) sidecarExit=$($side.HasExited)"
        } catch { Log ('error: ' + $_.Exception.Message) }
        finally {
            StopTree $side
            StopTree $workerProc
            StopTree $routerProc
            Remove-Item (Join-Path $stateDir 'rdc-sidecar.pid'),$workerPidFile,(Join-Path $stateDir 'rdc-router.pid') -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 10
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
