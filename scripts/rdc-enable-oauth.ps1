[CmdletBinding()]
param(
    [string]$LocalDeviceId='',
    [string]$LocalDeviceName=$env:COMPUTERNAME,
    [string]$PublicBaseUrl=''
)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$example=Join-Path $repoRoot 'config\rdc.env.example'
$config=Join-Path $repoRoot 'config\rdc.env'
$devicesFile=Join-Path $repoRoot 'config\devices.json'
$stateDir=Join-Path $repoRoot '.state'
$secretFile=Join-Path $stateDir 'rdc-approval-secret.txt'
$dcScript=Join-Path $repoRoot 'node_modules\@wonderwhy-er\desktop-commander\dist\index.js'
$utf8=New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function NewRandomToken {
    $bytes=New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}
if(-not $LocalDeviceId){
    if(Test-Path -LiteralPath $devicesFile){
        $existingRegistry=Get-Content -LiteralPath $devicesFile -Raw | ConvertFrom-Json
        $existingLocal=@($existingRegistry.devices | Where-Object { $_.local -eq $true -and $_.enabled -ne $false }) | Select-Object -First 1
        if($existingLocal){ $LocalDeviceId=[string]$existingLocal.deviceId }
    }
    if(-not $LocalDeviceId){
        $candidate=([string]$LocalDeviceName -replace '[^A-Za-z0-9._-]','-').Trim('-')
        if(-not $candidate){ $candidate='local-pc' }
        $LocalDeviceId=$candidate.ToLowerInvariant()
    }
}
$workerEnv=Join-Path $repoRoot ("config\worker-{0}.env" -f $LocalDeviceId)
if(-not (Test-Path -LiteralPath $config)){
    Copy-Item -LiteralPath $example -Destination $config
}
if($PublicBaseUrl){
    try { $baseUri=[Uri]$PublicBaseUrl } catch { throw 'PublicBaseUrl must be an absolute HTTPS origin.' }
    if(-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -ne 'https' -or $baseUri.AbsolutePath -ne '/' -or $baseUri.UserInfo -or $baseUri.Query -or $baseUri.Fragment){
        throw 'PublicBaseUrl must be a clean HTTPS origin without credentials, path, query, or fragment, for example https://your-machine.your-tailnet.ts.net.'
    }
    $base=$PublicBaseUrl.TrimEnd('/')
    $configText=Get-Content -LiteralPath $config -Raw
    $configText=[regex]::Replace($configText,'(?m)^RDC_ISSUER=.*$',"RDC_ISSUER=$base/rdc")
    $configText=[regex]::Replace($configText,'(?m)^RDC_RESOURCE=.*$',"RDC_RESOURCE=$base/rdc/mcp")
    [IO.File]::WriteAllText($config,$configText,$utf8)
}
if((Get-Content -LiteralPath $config -Raw) -match 'your-machine\.your-tailnet\.ts\.net'){
    throw 'Set the public hostname in config\rdc.env or rerun with -PublicBaseUrl https://your-machine.your-tailnet.ts.net.'
}
if(-not (Test-Path -LiteralPath $secretFile)){
    [IO.File]::WriteAllText($secretFile,(NewRandomToken)+"`n",[Text.Encoding]::ASCII)
}

$localToken=$null
if(-not (Test-Path -LiteralPath $devicesFile)){
    $localToken=NewRandomToken
    $registry=[ordered]@{
        defaultDeviceId=$LocalDeviceId
        devices=@([ordered]@{
            deviceId=$LocalDeviceId
            name=$LocalDeviceName
            enabled=$true
            local=$true
            token=$localToken
            notes='Controller host; native Windows Desktop Commander'
        })
    }
    [IO.File]::WriteAllText($devicesFile,($registry | ConvertTo-Json -Depth 6)+"`n",$utf8)
} else {
    $registry=Get-Content -LiteralPath $devicesFile -Raw | ConvertFrom-Json
    $local=$registry.devices | Where-Object { $_.deviceId -eq $LocalDeviceId -and $_.local -eq $true } | Select-Object -First 1
    if(-not $local -or -not $local.token){ throw "Local device $LocalDeviceId is missing a token in config\devices.json." }
    $localToken=[string]$local.token
}if(-not (Test-Path -LiteralPath $workerEnv)){
    $workerLines=@(
        "WC_DEVICE_ID=$LocalDeviceId"
        "WC_DEVICE_NAME=$LocalDeviceName"
        'WC_CONTROLLER_HOST=127.0.0.1'
        'WC_CONTROLLER_PORT=18101'
        "WC_WORKER_TOKEN=$localToken"
        "WC_DC_SCRIPT=$dcScript"
        'WC_RECONNECT_MS=3000'
    ) -join "`n"
    [IO.File]::WriteAllText($workerEnv,$workerLines+"`n",$utf8)
}

Write-Output 'Windows Console controller local config is ready.'
Write-Output ('OAuth config: ' + $config)
Write-Output ('Device registry: ' + $devicesFile)
Write-Output ('Local worker config: ' + $workerEnv)
Write-Output ('Approval secret: ' + $secretFile + ' (local-only; do not paste it into chat)')