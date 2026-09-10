[CmdletBinding()]
param()
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $repoRoot 'logs\watchdog'
$snapshotDir = Join-Path $logRoot 'snapshots'
$watchLog = Join-Path $logRoot 'watchdog.log'
$httpLog = Join-Path $repoRoot 'logs\rdc-http.log'
$routerTraceLog = Join-Path $repoRoot 'logs\router-trace.log'
$supervisorLog = Join-Path $repoRoot 'logs\rdc-supervisor.log'
$maintenanceFlag = Join-Path $repoRoot '.state\gateway-maintenance.lock'
$taskName = 'Desktop Commander Selfhost Gateway'
$ports = @(18008,18009,18100,18101)
$oauthConfig = Join-Path $repoRoot 'config\rdc.env'
$issuerLine = Get-Content $oauthConfig -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*RDC_ISSUER\s*=' } | Select-Object -First 1
$issuer = if($issuerLine){ ($issuerLine -replace '^\s*RDC_ISSUER\s*=\s*','').Trim() } else { '' }
try {
  $issuerUri = [Uri]$issuer
  $issuerPath = if($issuerUri.AbsolutePath -eq '/') { '' } else { $issuerUri.AbsolutePath.TrimEnd('/') }
  $publicProbe = "$($issuerUri.Scheme)://$($issuerUri.Authority)/.well-known/oauth-authorization-server$issuerPath"
} catch { $publicProbe = $null }
New-Item -ItemType Directory -Force -Path $logRoot,$snapshotDir | Out-Null
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true,'Global\WcmDiagnosticsWatchdog',[ref]$createdNew)
if(-not $createdNew){ $mutex.Dispose(); exit 0 }
function Log([string]$message){
  "[$(Get-Date -Format o)] $message" | Out-File $watchLog -Encoding utf8 -Append
}
function Get-PortBits {
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
  return (($ports | ForEach-Object { if($listeners.LocalPort -contains $_){'1'}else{'0'} }) -join '')
}
function Get-RouterHealth {
  try { $h=Invoke-RestMethod 'http://127.0.0.1:18009/health' -TimeoutSec 2; return [string]$h.status }
  catch { return 'ERR' }
}
function Get-PublicCode {
  try {
    $code = & curl.exe --noproxy '*' -sS -o NUL -w '%{http_code}' --max-time 5 $publicProbe 2>$null
    if([string]::IsNullOrWhiteSpace($code)){ return '000' }
    return [string]$code
  } catch { return '000' }
}
function Snapshot([string]$reason){
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $file = Join-Path $snapshotDir ("snapshot-$stamp.txt")
  "time=$(Get-Date -Format o)`r`nreason=$reason" | Out-File $file -Encoding utf8
  "`r`n=== TASKS ===" | Out-File $file -Append -Encoding utf8
  Get-ScheduledTask | Where-Object {$_.TaskName -match 'Desktop Commander|BMG|Browser|CAM'} |
    Select-Object TaskName,State | Format-Table -AutoSize | Out-String | Out-File $file -Append -Encoding utf8
  Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue |
    Format-List * | Out-String | Out-File $file -Append -Encoding utf8
  "`r`n=== PORTS ===" | Out-File $file -Append -Encoding utf8
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object {$_.LocalPort -in $ports} | Sort-Object LocalPort |
    Format-Table -AutoSize | Out-String | Out-File $file -Append -Encoding utf8
  "`r`n=== PROCESSES ===" | Out-File $file -Append -Encoding utf8
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {$_.CommandLine -match 'windows-console-mcp|browser-mcp-gateway|tailscale'} |
    Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine |
    Format-List | Out-String | Out-File $file -Append -Encoding utf8
  "`r`n=== HEALTH ===" | Out-File $file -Append -Encoding utf8
  "router=$(Get-RouterHealth) public=$(Get-PublicCode) ports=$(Get-PortBits)" | Out-File $file -Append -Encoding utf8
  "`r`n=== FUNNEL ===" | Out-File $file -Append -Encoding utf8
  (& tailscale.exe funnel status 2>&1 | Out-String) | Out-File $file -Append -Encoding utf8
  "`r`n=== TAILSCALE STATUS ===" | Out-File $file -Append -Encoding utf8
  (& tailscale.exe status 2>&1 | Out-String) | Out-File $file -Append -Encoding utf8
  "`r`n=== SUPERVISOR TAIL ===" | Out-File $file -Append -Encoding utf8
  Get-Content $supervisorLog -Tail 80 -ErrorAction SilentlyContinue | Out-File $file -Append -Encoding utf8
  "`r`n=== HTTP TAIL ===" | Out-File $file -Append -Encoding utf8
  Get-Content $httpLog -Tail 120 -ErrorAction SilentlyContinue | Out-File $file -Append -Encoding utf8
  "`r`n=== ROUTER TRACE TAIL ===" | Out-File $file -Append -Encoding utf8
  Get-Content $routerTraceLog -Tail 160 -ErrorAction SilentlyContinue | Out-File $file -Append -Encoding utf8
  "`r`n=== TASK EVENTS 15M ===" | Out-File $file -Append -Encoding utf8
  Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational';StartTime=(Get-Date).AddMinutes(-15)} -ErrorAction SilentlyContinue |
    Where-Object {$_.Message -match $taskName} | Select-Object TimeCreated,Id,LevelDisplayName,Message |
    Format-List | Out-String | Out-File $file -Append -Encoding utf8
  Get-ChildItem $snapshotDir -Filter 'snapshot-*.txt' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 40 | Remove-Item -Force -ErrorAction SilentlyContinue
  Log "SNAPSHOT reason=$reason file=$file"
}
$lastState = ''
$lastSnapshotAt = [datetime]::MinValue
$lastHttpAnomaly = (Get-Content $httpLog -Tail 200 -ErrorAction SilentlyContinue |
  Where-Object {$_ -match 'HTTP POST /rdc/mcp status=(400|502)|UPSTREAM ERROR'} | Select-Object -Last 1)
Log 'watchdog started'
try {
  while($true){
    try {
      $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      $taskState = if($task){[string]$task.State}else{'Missing'}
      $portBits = Get-PortBits
      $routerHealth = Get-RouterHealth
      $publicCode = Get-PublicCode
      $maintenance = Test-Path $maintenanceFlag
      $state = if($maintenance){ "maintenance task=$taskState ports=$portBits router=$routerHealth public=$publicCode" } else { "task=$taskState ports=$portBits router=$routerHealth public=$publicCode" }
      $healthy = $maintenance -or ($taskState -eq 'Running' -and $portBits -eq '1111' -and $routerHealth -eq 'ok' -and $publicCode -eq '200')
      if($state -ne $lastState){
        Log "STATE $state"
        if(-not $healthy){ Snapshot("state-change $state"); $lastSnapshotAt=Get-Date }
        $lastState = $state
      }
      $httpAnomaly = (Get-Content $httpLog -Tail 80 -ErrorAction SilentlyContinue |
        Where-Object {$_ -match 'HTTP POST /rdc/mcp status=(400|502)|UPSTREAM ERROR'} | Select-Object -Last 1)
      if($httpAnomaly -and $httpAnomaly -ne $lastHttpAnomaly){
        if($maintenance){
          Log "HTTP-ANOMALY-SUPPRESSED maintenance $httpAnomaly"
        } else {
          Log "HTTP-ANOMALY $httpAnomaly"
        if(((Get-Date)-$lastSnapshotAt).TotalSeconds -ge 20){ Snapshot("http-anomaly $httpAnomaly"); $lastSnapshotAt=Get-Date }
        }
        $lastHttpAnomaly = $httpAnomaly
      }
    } catch { Log ('LOOP-ERROR ' + $_.Exception.Message) }
    Start-Sleep -Seconds 10
  }
} finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
