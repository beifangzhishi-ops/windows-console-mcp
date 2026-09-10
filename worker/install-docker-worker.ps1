[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DeviceId,
    [Parameter(Mandatory=$true)][string]$ControllerHost,
    [int]$ControllerPort=18100,
    [string]$DeviceName='',
    [string]$WorkspaceRoot='',
    [string]$ContainerName='windows-console-worker',
    [string]$Image='node:22.23.2-bookworm'
)
$ErrorActionPreference='Stop'
$workerDir=$PSScriptRoot
if(-not $DeviceName){ $DeviceName=$env:COMPUTERNAME; if(-not $DeviceName){$DeviceName=$DeviceId} }
if(-not $WorkspaceRoot){ $WorkspaceRoot=Split-Path -Parent $workerDir }
$docker=(Get-Command docker.exe -CommandType Application -ErrorAction Stop).Source
$agent=Join-Path $workerDir 'agent.mjs'
$lock=Join-Path $workerDir 'package-lock.json'
$dc=Join-Path $workerDir 'node_modules\@wonderwhy-er\desktop-commander\dist\index.js'
foreach($file in @($agent,$lock)){ if(-not (Test-Path $file)){ throw "Missing worker file: $file" } }

if(-not (Test-Path $dc)){
    Write-Output 'Installing pinned worker dependencies...'
    & $docker run --rm --mount "type=bind,source=$workerDir,target=/app" -w /app $Image npm ci --omit=dev
    if($LASTEXITCODE -ne 0){ throw 'Worker dependency install failed.' }
}
$envFile=Join-Path $workerDir 'worker.env'
$envText=@(
    "WC_DEVICE_ID=$DeviceId"
    "WC_DEVICE_NAME=$DeviceName"
    "WC_CONTROLLER_HOST=$ControllerHost"
    "WC_CONTROLLER_PORT=$ControllerPort"
    'WC_DC_NODE=/usr/local/bin/node'
    'WC_DC_SCRIPT=/app/node_modules/@wonderwhy-er/desktop-commander/dist/index.js'
    'WC_RECONNECT_MS=3000'
) -join "`n"
[IO.File]::WriteAllText($envFile,$envText+"`n",(New-Object Text.UTF8Encoding($false)))

$existing=& $docker ps -a --filter "name=^/$ContainerName$" --format '{{.Names}}'
if($existing -eq $ContainerName){ & $docker rm -f $ContainerName | Out-Null }
$args=@(
    'run','-d','--name',$ContainerName,'--restart','unless-stopped',
    '--mount',"type=bind,source=$workerDir,target=/app",
    '--mount','type=bind,source=C:\,target=/host,readonly',
    '--mount',"type=bind,source=$WorkspaceRoot,target=/workspace",
    '-w','/app',$Image,'node','agent.mjs','worker.env'
)
$containerId=& $docker @args
if($LASTEXITCODE -ne 0 -or -not $containerId){ throw 'Failed to start worker container.' }

$connected=$false
for($i=0;$i -lt 15;$i++){
    Start-Sleep -Seconds 1
    $logs=(& $docker logs $ContainerName 2>&1 | Out-String)
    if($logs -match 'Connected to controller as ' + [regex]::Escape($DeviceId) + '\.'){
        $connected=$true
        break
    }
    $running=& $docker inspect -f '{{.State.Running}}' $ContainerName 2>$null
    if($running -ne 'true'){ break }
}
if(-not $connected){
    & $docker logs --tail 50 $ContainerName 2>&1 | Write-Output
    throw 'Worker container started but did not connect to the controller.'
}
Write-Output ("Worker {0} connected. Container={1}; restart=unless-stopped" -f $DeviceId,$ContainerName)