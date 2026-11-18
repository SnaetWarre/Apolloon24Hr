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
    if (!$window.CloseMainWindow() -or !$window.WaitForExit(15000)) {
        throw 'Native desktop window did not close normally'
    }

    $removed = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
    if ($removed.ExitCode -ne 0 -or (Test-Path $exe)) { throw 'Native uninstall failed' }
    if (Get-NetFirewallRule -DisplayName $rules -ErrorAction SilentlyContinue) {
        throw 'Native firewall rules remained after uninstall'
    }
    if (!(Test-Path $env:APOLLOON_NATIVE_DATA)) { throw 'Uninstall removed the race database' }
    Write-Host 'PASS: native Windows setup, firewall, real window startup and shutdown, and uninstall'
} finally {
    if ($null -ne $window -and !$window.HasExited) {
        & taskkill /PID $window.Id /T /F | Out-Null
    }
    if (Test-Path $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
    }
    Remove-Item -LiteralPath $root -Recurse -Force
}
