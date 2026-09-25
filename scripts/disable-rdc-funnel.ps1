[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
$routes=@('/rdc/mcp','/rdc/authorize','/rdc/token','/rdc/register','/rdc/revoke','/rdc/oauth/consent','/.well-known/oauth-authorization-server/rdc','/.well-known/oauth-protected-resource/rdc/mcp','/rdc/.well-known/oauth-authorization-server','/rdc/mcp/.well-known/oauth-protected-resource')
Write-Output 'RDC Funnel disable preview:'
foreach($route in $routes){ Write-Output ("  tailscale funnel --https=443 --set-path={0} off" -f $route) }
if(-not $Apply){ Write-Output 'Preview only. Re-run with -Apply to change Funnel.'; exit 0 }
$ts=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if(-not(Test-Path $ts)){ $ts=(Get-Command tailscale.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source }
foreach($route in $routes){ & $ts funnel --https=443 "--set-path=$route" --yes off; if($LASTEXITCODE -ne 0){ throw "Failed disabling $route" } }
Write-Output 'RDC Funnel routes disabled.'
