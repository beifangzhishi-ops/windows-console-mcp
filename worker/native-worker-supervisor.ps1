[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DeviceId,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$EnvFile
)
$ErrorActionPreference='Stop'
if($DeviceId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'){ throw 'Invalid DeviceId.' }
$workerDir=$PSScriptRoot
$repoRoot=Split-Path -Parent $workerDir
$stateDir=Join-Path $repoRoot '.state'
$logDir=Join-Path $repoRoot 'logs'
$agent=Join-Path $workerDir 'agent.mjs'
$safeId=$DeviceId -replace '[^A-Za-z0-9._-]','-'
$supervisorPidFile=Join-Path $stateDir ("native-worker-{0}-supervisor.pid" -f $safeId)
$agentPidFile=Join-Path $stateDir ("native-worker-{0}-agent.pid" -f $safeId)
$supervisorLog=Join-Path $logDir ("native-worker-{0}-supervisor.log" -f $safeId)
$stdoutLog=Join-Path $logDir ("native-worker-{0}-stdout.log" -f $safeId)
$stderrLog=Join-Path $logDir ("native-worker-{0}-stderr.log" -f $safeId)
New-Item -ItemType Directory -Force -Path $stateDir,$logDir | Out-Null
foreach($file in @($NodePath,$EnvFile,$agent)){ if(-not (Test-Path -LiteralPath $file)){ throw "Missing native worker runtime file: $file" } }

$createdNew=$false
$mutexName='Global\WindowsConsoleNativeWorker-' + $safeId
$mutex=New-Object System.Threading.Mutex($true,$mutexName,[ref]$createdNew)
if(-not $createdNew){ $mutex.Dispose(); exit 0 }
Set-Content -LiteralPath $supervisorPidFile -Value $PID -Encoding ASCII

function Log([string]$message){
    "[$(Get-Date -Format s)] $message" | Out-File -LiteralPath $supervisorLog -Encoding utf8 -Append
}
function StopChild($proc){
    if($null -eq $proc){ return }
    try {
        if(-not $proc.HasExited){ & "$env:WINDIR\System32\taskkill.exe" /PID $proc.Id /T /F *> $null }
    } catch {}
}

try {
    Log "supervisor started pid=$PID device=$DeviceId"
    while($true){
        $proc=$null
        try {
            Remove-Item -LiteralPath $stdoutLog,$stderrLog -Force -ErrorAction SilentlyContinue
            $agentArg='"' + $agent + '"'
            $envArg='"' + $EnvFile + '"'
            $proc=Start-Process -FilePath $NodePath -ArgumentList @($agentArg,$envArg) -WorkingDirectory $workerDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
            Set-Content -LiteralPath $agentPidFile -Value $proc.Id -Encoding ASCII
            Log "agent started pid=$($proc.Id)"
            $proc.WaitForExit()
            Log "agent exited pid=$($proc.Id) code=$($proc.ExitCode)"
        } catch {
            Log ('agent error: ' + $_.Exception.Message)
        } finally {
            StopChild $proc
            Remove-Item -LiteralPath $agentPidFile -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 3
    }
} finally {
    Remove-Item -LiteralPath $agentPidFile,$supervisorPidFile -Force -ErrorAction SilentlyContinue
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
