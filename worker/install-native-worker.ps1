[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DeviceId,
    [Parameter(Mandatory=$true)][string]$ControllerHost,
    [int]$ControllerPort=18100,
    [string]$DeviceName='',
    [string]$TaskName='',
    [int]$ConnectTimeoutSeconds=20
)
$ErrorActionPreference='Stop'
if($DeviceId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'){ throw 'Invalid DeviceId.' }
if(-not $ControllerHost.Trim()){ throw 'ControllerHost is required.' }
if($ControllerHost -match '[\r\n\t ]'){ throw 'ControllerHost must be a single hostname or IP address without whitespace.' }
if($ControllerPort -lt 1 -or $ControllerPort -gt 65535){ throw 'Invalid ControllerPort.' }
if($ConnectTimeoutSeconds -lt 1 -or $ConnectTimeoutSeconds -gt 300){ throw 'ConnectTimeoutSeconds must be between 1 and 300.' }
$workerDir=$PSScriptRoot
$repoRoot=Split-Path -Parent $workerDir
$configDir=Join-Path $repoRoot 'config'
$stateDir=Join-Path $repoRoot '.state'
$supervisor=Join-Path $workerDir 'native-worker-supervisor.ps1'
$agent=Join-Path $workerDir 'agent.mjs'
$uninstaller=Join-Path $workerDir 'uninstall-native-worker.ps1'
if(-not $DeviceName){ $DeviceName=$env:COMPUTERNAME; if(-not $DeviceName){ $DeviceName=$DeviceId } }
if($DeviceName -match '[\r\n]'){ throw 'DeviceName must not contain line breaks.' }
if(-not $TaskName){ $TaskName="Windows Console Native Worker - $DeviceId" }

$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$npm=(Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$nodeMajor=[int]((& $node -p "process.versions.node.split('.')[0]").Trim())
if($nodeMajor -lt 20){ throw "Node.js 20 or newer is required; found major version $nodeMajor." }
$tailscale=(Get-Command tailscale.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if(-not $tailscale){
    $candidate=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if(Test-Path -LiteralPath $candidate){ $tailscale=$candidate }
}
if(-not $tailscale){ throw 'Tailscale is required for a remote native worker.' }
$tailIp=[string](& $tailscale ip -4 2>$null | Select-Object -First 1)
$tailIp=$tailIp.Trim()
if(-not $tailIp){ throw 'Tailscale IPv4 was unavailable.' }
foreach($file in @($supervisor,$agent,$uninstaller,(Join-Path $workerDir 'package-lock.json'))){ if(-not (Test-Path -LiteralPath $file)){ throw "Missing worker file: $file" } }

$safeId=$DeviceId -replace '[^A-Za-z0-9._-]','-'
$existingTask=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$existingSupervisorPid=Join-Path $stateDir ("native-worker-{0}-supervisor.pid" -f $safeId)
$existingAgentPid=Join-Path $stateDir ("native-worker-{0}-agent.pid" -f $safeId)
if($existingTask -or (Test-Path -LiteralPath $existingSupervisorPid) -or (Test-Path -LiteralPath $existingAgentPid)){
    & $uninstaller -DeviceId $DeviceId -TaskName $TaskName
}

Push-Location $workerDir
try {
    & $npm ci --omit=dev
    if($LASTEXITCODE -ne 0){ throw 'Native worker dependency install failed.' }
} finally { Pop-Location }

$dc=Join-Path $workerDir 'node_modules\@wonderwhy-er\desktop-commander\dist\index.js'
if(-not (Test-Path -LiteralPath $dc)){ throw "Desktop Commander entry point was not found: $dc" }
New-Item -ItemType Directory -Force -Path $configDir,$stateDir | Out-Null
$envFile=Join-Path $configDir ("worker-native-{0}.env" -f $DeviceId)
$envText=@(
    "WC_DEVICE_ID=$DeviceId"
    "WC_DEVICE_NAME=$DeviceName"
    "WC_CONTROLLER_HOST=$ControllerHost"
    "WC_CONTROLLER_PORT=$ControllerPort"
    "WC_DC_NODE=$node"
    "WC_DC_SCRIPT=$dc"
    'WC_RECONNECT_MS=3000'
    'WC_MAX_DC_RESPONSE_BYTES=524288'
) -join "`n"
[IO.File]::WriteAllText($envFile,$envText+"`n",(New-Object Text.UTF8Encoding($false)))

$vbs=Join-Path $stateDir ("native-worker-{0}-hidden.vbs" -f $safeId)
$psCommand="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$supervisor`" -DeviceId `"$DeviceId`" -NodePath `"$node`" -EnvFile `"$envFile`""
$escaped=$psCommand.Replace('"','""')
@"
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("$escaped", 0, True)
WScript.Quit rc
"@ | Set-Content -LiteralPath $vbs -Encoding ASCII

$action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$vbs`""
$taskUser=[string](& whoami.exe 2>$null)
$taskUser=$taskUser.Trim()
if(-not $taskUser){
    if($env:USERDOMAIN -and $env:USERNAME){ $taskUser="$env:USERDOMAIN\$env:USERNAME" }
    elseif($env:USERNAME){ $taskUser=$env:USERNAME }
}
if(-not $taskUser){ throw 'Unable to determine the current Windows account for Scheduled Task registration.' }
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$trigger.Delay='PT1M'
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
$stdoutLog=Join-Path $repoRoot ("logs\native-worker-{0}-stdout.log" -f $safeId)
$stderrLog=Join-Path $repoRoot ("logs\native-worker-{0}-stderr.log" -f $safeId)
Remove-Item -LiteralPath $stdoutLog,$stderrLog -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
$connected=$false
for($i=0;$i -lt $ConnectTimeoutSeconds;$i++){
    Start-Sleep -Seconds 1
    $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if($task.State -ne 'Running'){ break }
    if(Test-Path -LiteralPath $stdoutLog){
        $stdout=Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue
        if($stdout -match ('Connected to controller as ' + [regex]::Escape($DeviceId) + '\.')){
            $connected=$true
            break
        }
    }
}
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if($task.State -ne 'Running'){ throw "Native worker task is not running; state=$($task.State)." }
if(-not $connected){ throw "Native worker task is running but Controller connection was not confirmed within $ConnectTimeoutSeconds seconds. Use status-native-worker.ps1 for logs." }
Write-Output ("Native worker template installed. Device={0}; task={1}; TailscaleIPv4={2}" -f $DeviceId,$TaskName,$tailIp)
Write-Output ("Environment: " + $envFile)
Write-Output 'Verify the device from the Controller with list_devices before removing any previous worker.'
