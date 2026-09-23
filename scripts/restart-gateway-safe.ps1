[CmdletBinding()]
param([int]$TimeoutSeconds = 45)

$ErrorActionPreference = 'Stop'
$taskName = 'Desktop Commander Selfhost Gateway'
$ports = @(18008, 18009, 18100, 18101)
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $repoRoot '.state'
$maintenanceFlag = Join-Path $stateDir 'gateway-maintenance.lock'
$devicesFile = Join-Path $repoRoot 'config\devices.json'

if (-not (Test-Path -LiteralPath $devicesFile)) {
    throw "Missing runtime file: $devicesFile"
}
$registry = Get-Content -LiteralPath $devicesFile -Raw | ConvertFrom-Json
$localDevice = @($registry.devices |
    Where-Object { $_.local -eq $true -and $_.enabled -ne $false }) |
    Select-Object -First 1
if (-not $localDevice) {
    throw 'config\devices.json does not define an enabled local device.'
}
$localDeviceId = [string]$localDevice.deviceId

$ownedProcesses = @(
    @{
        Role = 'supervisor'
        PidFile = Join-Path $stateDir 'rdc-supervisor.pid'
        CommandPattern = [regex]::Escape((Join-Path $repoRoot 'scripts\rdc-supervisor.ps1'))
    },
    @{
        Role = 'router'
        PidFile = Join-Path $stateDir 'rdc-router.pid'
        CommandPattern = [regex]::Escape((Join-Path $repoRoot 'router\server.mjs'))
    },
    @{
        Role = 'worker'
        PidFile = Join-Path $stateDir ("rdc-worker-{0}.pid" -f $localDeviceId)
        CommandPattern = [regex]::Escape((Join-Path $repoRoot 'worker\agent.mjs'))
    },
    @{
        Role = 'sidecar'
        PidFile = Join-Path $stateDir 'rdc-sidecar.pid'
        CommandPattern = [regex]::Escape((Join-Path $repoRoot 'rdc-sidecar\server.mjs'))
    }
)

function Wait-For([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Read-PidFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [string](Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
    $parsed = 0
    if ([int]::TryParse($text.Trim(), [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $null
}

function Get-ProcessInfo([int]$ProcessId) {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Find-OwnedProcessInfo($Entry) {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { ([string]$_.CommandLine) -match $Entry.CommandPattern })
}

function Stop-OwnedProcess($Entry) {
    $processMatches = @()
    $pidFromFile = Read-PidFile $Entry.PidFile
    if ($null -ne $pidFromFile) {
        $info = Get-ProcessInfo $pidFromFile
        if ($null -ne $info -and ([string]$info.CommandLine) -match $Entry.CommandPattern) {
            $processMatches += $info
        } elseif ($null -ne $info) {
            Write-Output ("Ignoring stale {0} PID file {1}: PID {2} is not the expected WCM process." -f
                $Entry.Role, $Entry.PidFile, $pidFromFile)
        }
    }
    $processMatches += @(Find-OwnedProcessInfo $Entry)
    $processMatches = @($processMatches | Sort-Object ProcessId -Unique)
    foreach ($info in $processMatches) {
        $processId = [int]$info.ProcessId
        Write-Output ("Force-stopping stale WCM {0} PID {1}." -f $Entry.Role, $processId)
        & taskkill.exe /PID $processId /T /F | Out-Null
    }
    Remove-Item -LiteralPath $Entry.PidFile -Force -ErrorAction SilentlyContinue
}

function GatewayStopped {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in $ports })
    if ($listeners.Count -ne 0) { return $false }
    foreach ($entry in $ownedProcesses) {
        if ((Find-OwnedProcessInfo $entry).Count -gt 0) {
            return $false
        }
    }
    return $true
}

New-Item -ItemType File -Force -Path $maintenanceFlag | Out-Null
try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $graceSeconds = [Math]::Min(8, [Math]::Max(2, [Math]::Floor($TimeoutSeconds / 3)))
    $stopped = Wait-For { GatewayStopped } $graceSeconds
    if (-not $stopped) {
        Write-Output "Graceful gateway stop did not complete; cleaning up verified WCM PIDs."
        # Stop the supervisor first so it cannot respawn children, then clean up each child.
        foreach ($entry in $ownedProcesses) {
            Stop-OwnedProcess $entry
        }
        $remainingSeconds = [Math]::Max(5, $TimeoutSeconds - $graceSeconds)
        $stopped = Wait-For { GatewayStopped } $remainingSeconds
    }
    if (-not $stopped) {
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -in $ports } |
            Select-Object LocalAddress,LocalPort,OwningProcess)
        $detail = ($listeners | ForEach-Object {
            "{0}:{1} pid={2}" -f $_.LocalAddress,$_.LocalPort,$_.OwningProcess
        }) -join '; '
        throw "Gateway did not stop cleanly within $TimeoutSeconds seconds. Remaining listeners: $detail"
    }

    Start-ScheduledTask -TaskName $taskName
    $ready = Wait-For {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -in $ports })
        $uniquePorts = @($listeners.LocalPort | Sort-Object -Unique)
        return $task.State -eq 'Running' -and $uniquePorts.Count -eq $ports.Count
    } $TimeoutSeconds

    if (-not $ready) {
        throw "Gateway did not become ready within $TimeoutSeconds seconds."
    }

    $task = Get-ScheduledTask -TaskName $taskName
    $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in $ports } |
        Select-Object LocalAddress,LocalPort,OwningProcess |
        Sort-Object LocalPort
    Write-Output "Gateway restart complete. State=$($task.State)"
    $listeners | Format-Table -AutoSize
}
finally {
    Remove-Item $maintenanceFlag -Force -ErrorAction SilentlyContinue
}