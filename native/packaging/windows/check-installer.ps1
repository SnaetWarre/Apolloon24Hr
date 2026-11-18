param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("apolloon-native-" + [guid]::NewGuid())
$install = Join-Path $root 'app'
$profile = Join-Path $root 'profile'
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$exe = Join-Path $install 'apolloon-native.exe'
$uninstaller = Join-Path $install 'uninstall.exe'
$rules = @('Apolloon Native TCP 5173', 'Apolloon Native UDP 45737')
$window = $null

try {
    $setupResult = Start-Process -FilePath (Resolve-Path $Setup) -ArgumentList @('/S', "/D=$install") -PassThru -Wait
    if ($setupResult.ExitCode -ne 0 -or !(Test-Path $exe)) {
        throw "Native setup failed with exit code $($setupResult.ExitCode)"
    }
    foreach ($name in $rules) {
        $rule = Get-NetFirewallRule -DisplayName $name
        if ($rule.Action -ne 'Allow' -or ($rule | Get-NetFirewallApplicationFilter).Program -ne $exe) {
            throw "Unexpected rule for $name"
        }
    }

    $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $socket.Start()
    $port = $socket.LocalEndpoint.Port
    $socket.Stop()
    "PORT=$port" | Set-Content -Path (Join-Path $profile '.env')
    $env:APOLLOON_NATIVE_DATA = Join-Path $profile 'app.db'
    $env:APOLLOON_UPDATE_CHECK = '0'
    $env:CLUSTER_ENABLED = 'false'
    $env:BACKUP_ENABLED = 'false'

    $window = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
    $deadline = (Get-Date).AddSeconds(45)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $window.Refresh()
        if ($window.HasExited) { break }
        if ($window.MainWindowTitle -eq 'Apolloon Telsysteem') {
            try {
                $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 2
                if ($health.ok) { $ready = $true; break }
            } catch {}
        }
        Start-Sleep -Milliseconds 200
    }
    if (!$ready) { throw 'Native desktop window or Rust server did not start' }

    $api = "http://127.0.0.1:$port/api"
    $serverPid = Get-NetTCPConnection -LocalPort $port -State Listen |
        Select-Object -ExpandProperty OwningProcess -Unique
    $server = Get-Process -Id $serverPid
    if ($server.Path -ne $exe -or $server.Id -eq $window.Id) {
        throw 'Expected the installed Rust server in a separate process'
    }
    $runner = Invoke-RestMethod "$api/action/runners.create" -Method Post -ContentType 'application/json' `
        -Body '{"name":"Windows recovery runner","status":"waiting"}' -TimeoutSec 2
    $start = @{ activeRunnerId = $null; activeStartedAt = $null; pressedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    Invoke-RestMethod "$api/action/race.handoff" -Method Post -ContentType 'application/json' `
        -Body ($start | ConvertTo-Json -Compress) -TimeoutSec 2 | Out-Null

    Stop-Process -InputObject $window -Force
    $deadline = (Get-Date).AddSeconds(30)
    $replacement = $null
    do {
        $state = Invoke-RestMethod "$api/state" -TimeoutSec 2
        if ($state.race.activeRunnerId -ne $runner.id -or !$state.race.activeStartedAt) {
            throw 'Timing changed after the window process stopped'
        }
        if ((Get-NetTCPConnection -LocalPort $port -State Listen).OwningProcess -notcontains $serverPid) {
            throw 'Windows recovery replaced the original timing server'
        }
        foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId = $serverPid AND Name = 'apolloon-native.exe'") {
            $candidate = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            if ($candidate.Path -eq $exe -and $candidate.MainWindowTitle -eq 'Apolloon Telsysteem') {
                $replacement = $candidate
                break
            }
        }
        if (!$replacement) { Start-Sleep -Milliseconds 200 }
    } until ($replacement -or (Get-Date) -ge $deadline)
    if (!$replacement) { throw 'The native Windows window did not reopen after a crash' }
    $window = $replacement
    $finish = @{
        activeRunnerId = $state.race.activeRunnerId
        activeStartedAt = $state.race.activeStartedAt
        pressedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    Invoke-RestMethod "$api/action/race.finish" -Method Post -ContentType 'application/json' `
        -Body ($finish | ConvertTo-Json -Compress) -TimeoutSec 2 | Out-Null
    Write-Host 'PASS: crash recovery opened a new window while the original Windows server kept timing'
    # The close guard samples race health every five seconds.
    Start-Sleep -Seconds 6
    if (!$window.CloseMainWindow() -or !$window.WaitForExit(15000)) {
        throw 'Native desktop window did not close normally'
    }
    if (!$server.WaitForExit(15000)) {
        throw 'The native Windows server remained alive after the recovered window closed'
    }

    $removed = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
    if ($removed.ExitCode -ne 0 -or (Test-Path $exe)) { throw 'Native uninstall failed' }
    if (Get-NetFirewallRule -DisplayName $rules -ErrorAction SilentlyContinue) {
        throw 'Native firewall rules remained after uninstall'
    }
    if (!(Test-Path $env:APOLLOON_NATIVE_DATA)) { throw 'Uninstall removed the race database' }
    Write-Host 'PASS: native Windows setup, firewall, real window startup and shutdown, and uninstall'
} finally {
    foreach ($process in Get-Process -Name 'apolloon-native' -ErrorAction SilentlyContinue) {
        if ($process.Path -eq $exe) { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
    }
    Remove-Item -LiteralPath $root -Recurse -Force
}
