[CmdletBinding()]
param([int]$TimeoutSeconds = 45)

$ErrorActionPreference = 'Stop'
$taskName = 'Desktop Commander Selfhost Gateway'
$ports = @(18008, 18009, 18100, 18101)
$stateDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.state'
$maintenanceFlag = Join-Path $stateDir 'gateway-maintenance.lock'

function Wait-For([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

New-Item -ItemType File -Force -Path $maintenanceFlag | Out-Null
try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $stopped = Wait-For {
        $sup = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'windows-console-mcp\\scripts\\rdc-supervisor\.ps1' })
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -in $ports })
        return $sup.Count -eq 0 -and $listeners.Count -eq 0
    } $TimeoutSeconds
    if (-not $stopped) {
        throw "Gateway did not stop cleanly within $TimeoutSeconds seconds."
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