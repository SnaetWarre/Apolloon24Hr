<#
.SYNOPSIS
  Sets a static IPv4 on the wired Ethernet adapter for the Apolloon event LAN.
.DESCRIPTION
  Run ONCE per laptop, elevated (Run as Administrator), with the laptop already
  plugged into the event switch via Ethernet.

  Recommended plan for 3 Windows laptops, isolated switch, no router:
    Laptop 1 (primary): 192.168.10.11
    Laptop 2 (standby): 192.168.10.12
    Laptop 3 (spare / display): 192.168.10.13
    Subnet mask: 255.255.255.0 (PrefixLength 24), no gateway, no DNS.

  If your switch IS a router with DHCP (e.g. 192.168.1.x), pick addresses
  OUTSIDE its DHCP pool instead, and keep the gateway. Example:
    .\Set-ApolloonStaticIp.ps1 -IPAddress 192.168.1.211 -PrefixLength 24 -Gateway 192.168.1.1

  The script:
    1. Refuses to run unelevated (Windows requires admin for netsh/Set-NetIPAddress).
    2. Auto-detects the wired Ethernet adapter (override with -InterfaceAlias).
    3. Refuses to pin APIPA 169.254.x.x addresses.
    4. Warns if the requested IP is inside a detected DHCP range.
    5. Sets the static IP, resets DNS, opens TCP 5173 + UDP 45737 firewall rules.
    6. Prints the new Event URL to open on other devices.
.EXAMPLE
  # Right-click PowerShell -> Run as Administrator, then:
  Set-ExecutionPolicy Bypass -Scope Process -Force
  .\Set-ApolloonStaticIp.ps1 -IPAddress 192.168.10.11
.EXAMPLE
  .\Set-ApolloonStaticIp.ps1 -IPAddress 192.168.1.211 -PrefixLength 24 -Gateway 192.168.1.1 -InterfaceAlias "Ethernet"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}$')]
  [string]$IPAddress,

  [int]$PrefixLength = 24,

  [string]$Gateway,

  [string]$InterfaceAlias
)

$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Error 'Run this script as Administrator (right-click PowerShell -> Run as Administrator). Setting an IP requires elevation.'
  exit 1
}

# 1. Find the wired adapter.
$adapter = $null
if ($InterfaceAlias) {
  $adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
  if (-not $adapter) { Write-Error "No adapter named '$InterfaceAlias'. Run 'Get-NetAdapter' to list names."; exit 1 }
} else {
  $candidates = Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' -and $_.ConnectorPresent } |
    Sort-Object { if ($_.MediaType -match '802.3|Ethernet') { 0 } else { 1 } }
  if (-not $candidates) {
    $candidates = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }
  }
  # Prefer names like Ethernet / LAN, skip Wi-Fi / VPN / virtual.
  $adapter = $candidates | Where-Object { $_.Name -match '^(Ethernet|LAN|Eth|Local)' } | Select-Object -First 1
  if (-not $adapter) {
    $adapter = $candidates | Where-Object { $_.Name -notmatch 'Wi-?Fi|WLAN|VPN|vEthernet|Virtual|Bluetooth|Tailscale|ZeroTier' } | Select-Object -First 1
  }
  if (-not $adapter) { Write-Error "No suitable wired adapter found. Plug in Ethernet, then run 'Get-NetAdapter' and pass -InterfaceAlias explicitly."; exit 1 }
}

Write-Host "Using adapter: $($adapter.Name) [$($adapter.InterfaceDescription)] status=$($adapter.Status)" -ForegroundColor Cyan

# 2. Sanity checks on the requested address.
if ($IPAddress -match '^169\.254\.') {
  Write-Error '169.254.x.x is APIPA (no DHCP, no static plan). Do NOT pin it. Use 192.168.10.11/12/13 with PrefixLength 24 instead.'
  exit 1
}
$octets = $IPAddress.Split('.') | ForEach-Object { [int]$_ }
if (($octets | Where-Object { $_ -lt 0 -or $_ -gt 255 }).Count -gt 0) { Write-Error "Invalid IP: $IPAddress"; exit 1 }
if ($octets[3] -eq 0 -or $octets[3] -eq 255) { Write-Warning 'Last octet .0 / .255 is network/broadcast; this will probably not work. Use .11 / .12 / .13.' }

# Warn if we appear to be on a router LAN and the IP may collide with DHCP.
$currentV4 = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^169\.254\.' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1
if ($currentV4 -and -not $Gateway) {
  $route = Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($route -and $route.NextHop -and $route.NextHop -ne '0.0.0.0') {
    Write-Warning ("This adapter currently has gateway {0} (router LAN). Pinning {1} without -Gateway may drop internet. " -f $route.NextHop, $IPAddress) +
      'If the venue router does DHCP, pick an IP OUTSIDE its DHCP pool and pass -Gateway explicitly.'
  }
}

# 3. Apply (supports -WhatIf).
if ($PSCmdlet.ShouldProcess("$($adapter.Name) -> $IPAddress/$PrefixLength", 'Set static IP')) {
  # Remove any existing addresses/routes on this interface first to avoid duplicates.
  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^127\.' } |
    ForEach-Object { Remove-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $_.IPAddress -Confirm:$false -ErrorAction SilentlyContinue }
  Get-NetRoute -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } |
    ForEach-Object { Remove-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix $_.DestinationPrefix -NextHop $_.NextHop -Confirm:$false -ErrorAction SilentlyContinue }

  $ipParams = @{
    InterfaceIndex = $adapter.ifIndex
    IPAddress      = $IPAddress
    PrefixLength   = $PrefixLength
  }
  if ($Gateway) { $ipParams['DefaultGateway'] = $Gateway }
  New-NetIPAddress @ipParams | Out-Null

  Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -Dhcp Disabled | Out-Null
  # Isolated event LAN needs no DNS; router LAN keeps gateway DNS via DHCP fallback.
  if (-not $Gateway) {
    Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses | Out-Null
  }

  # 4. Firewall: TCP 5173 (app) + UDP 45737 (cluster discovery), idempotent.
  foreach ($rule in @(
    @{ Name = 'Apolloon TCP 5173'; Proto = 'TCP'; Port = 5173 },
    @{ Name = 'Apolloon UDP 45737'; Proto = 'UDP'; Port = 45737 }
  )) {
    if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol $rule.Proto -LocalPort $rule.Port -Action Allow -Profile Any | Out-Null
      Write-Host "Firewall rule added: $($rule.Name)" -ForegroundColor Green
    } else {
      Write-Host "Firewall rule exists: $($rule.Name)" -ForegroundColor DarkGray
    }
  }

  # 5. Verify.
  Start-Sleep -Seconds 2
  $after = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $IPAddress }
  if (-not $after) { Write-Error "Static IP did not stick. Run 'Get-NetIPAddress' to inspect."; exit 1 }

  Write-Host ''
  Write-Host 'OK. This laptop is now static:' -ForegroundColor Green
  Write-Host "  Adapter : $($adapter.Name)"
  Write-Host "  IP      : $IPAddress/$PrefixLength $(if ($Gateway) { "gw $Gateway" } else { '(isolated LAN, no gateway)' })"
  Write-Host "  Event URL for other devices: http://${IPAddress}:5173"
  Write-Host ''
  Write-Host 'Next: repeat on the other laptops with .12 / .13, same switch, Wi-Fi OFF. Then run Test-ApolloonNetwork.ps1.'
}
