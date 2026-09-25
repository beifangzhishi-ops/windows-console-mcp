[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
$port=18008
$routes=@('/rdc/mcp','/rdc/authorize','/rdc/token','/rdc/register','/rdc/revoke','/rdc/oauth/consent','/.well-known/oauth-authorization-server/rdc','/.well-known/oauth-protected-resource/rdc/mcp','/rdc/.well-known/oauth-authorization-server','/rdc/mcp/.well-known/oauth-protected-resource')
Write-Output 'RDC Funnel route preview:'
foreach($route in $routes){ Write-Output ("  {0} -> http://127.0.0.1:{1}{0}" -f $route,$port) }
if(-not $Apply){ Write-Output 'Preview only. Re-run with -Apply to change Funnel.'; exit 0 }
$health=Invoke-RestMethod 'http://127.0.0.1:18008/health' -TimeoutSec 3
if($health.status -ne 'ok'){ throw 'RDC sidecar health check failed.' }
$ts=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if(-not(Test-Path $ts)){ $ts=(Get-Command tailscale.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source }
foreach($route in $routes){ & $ts funnel --bg --https=443 "--set-path=$route" "http://127.0.0.1:$port$route"; if($LASTEXITCODE -ne 0){ throw "Failed Funnel route $route" } }
Write-Output 'RDC Funnel routes applied.'
