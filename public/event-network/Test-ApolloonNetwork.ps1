<#
.SYNOPSIS
  Pre-race network check for the Apolloon wired LAN. No admin rights needed.
.DESCRIPTION
  On EACH laptop, run (unelevated is fine):
    .\Test-ApolloonNetwork.ps1 -Peers 192.168.10.11,192.168.10.12,192.168.10.13

  Checks:
    - wired adapter present, Wi-Fi state (warns if Wi-Fi is still connected)
    - current IPv4, APIPA detection (169.254 = no DHCP and no static -> BAD)
    - gateway/DNS summary
    - ping to each peer, TCP 5173 to each peer (app), local TCP 5173 listener
    - prints the Event URL(s) this laptop advertises
  Exit 0 = all peers reachable on TCP 5173. Exit 1 = something needs fixing.
.EXAMPLE
  .\Test-ApolloonNetwork.ps1 -Peers 192.168.10.11,192.168.10.12,192.168.10.13
#>
param(
  [string[]]$Peers = @('192.168.10.11', '192.168.10.12', '192.168.10.13'),
  [int]$AppPort = 5173
)

$fail = $false

Write-Host '== Adapters ==' -ForegroundColor Cyan
$adapters = Get-NetAdapter -ErrorAction SilentlyContinue | Sort-Object Name
$adapters | Format-Table Name, Status, MediaType -AutoSize | Out-String | Write-Host
$wifiUp = $adapters | Where-Object { $_.Name -match 'Wi-?Fi|WLAN' -and $_.Status -eq 'Up' }
if ($wifiUp) { Write-Warning 'Wi-Fi is UP. Turn Wi-Fi OFF on timing laptops to avoid accidental routing.'; $fail = $true }

Write-Host '== IPv4 ==' -ForegroundColor Cyan
$addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^127\.' } |
  Select-Object InterfaceAlias, IPAddress, PrefixLength, PrefixOrigin
$addrs | Format-Table -AutoSize | Out-String | Write-Host
if ($addrs.IPAddress -match '^169\.254\.') {
  Write-Warning 'APIPA 169.254.x.x detected: no DHCP lease and no static IP. Set static IPs (Set-ApolloonStaticIp.ps1) before the race.'
  $fail = $true
}

Write-Host '== Local app port ==' -ForegroundColor Cyan
$listener = Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) { Write-Host "Something listens on TCP $AppPort (good if Apolloon is running)." -ForegroundColor Green }
else { Write-Warning "Nothing listens on TCP $AppPort. Start the Apolloon Electron app first." }

Write-Host '== Peers ==' -ForegroundColor Cyan
foreach ($peer in $Peers) {
  $pingOk = Test-Connection -ComputerName $peer -Count 2 -Quiet -ErrorAction SilentlyContinue
  $tcpOk = (Test-NetConnection -ComputerName $peer -Port $AppPort -WarningAction SilentlyContinue).TcpTestSucceeded
  $color = if ($pingOk -and $tcpOk) { 'Green' } else { 'Red' }
  Write-Host ("{0,-15} ping={1,-5} tcp{2}={3,-5}" -f $peer, $pingOk, $AppPort, $tcpOk) -ForegroundColor $color
  if (-not ($pingOk -and $tcpOk)) { $fail = $true }
}

Write-Host ''
$mine = ($addrs | Where-Object { $_.IPAddress -match '^(192\.168\.|10\.)' } | Select-Object -First 1).IPAddress
if ($mine) { Write-Host "This laptop's Event URL is likely: http://${mine}:${AppPort}" -ForegroundColor Cyan }
Write-Host 'Expected: all peers ping + tcp OK, no APIPA, Wi-Fi OFF.' -ForegroundColor DarkGray

if ($fail) { Write-Host 'RESULT: FAIL - fix warnings above before the race.' -ForegroundColor Red; exit 1 }
Write-Host 'RESULT: PASS' -ForegroundColor Green
exit 0
