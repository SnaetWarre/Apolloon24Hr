<#
.SYNOPSIS
  Reverts the event laptop back to DHCP (undoes Set-ApolloonStaticIp.ps1).
.DESCRIPTION
  Run as Administrator. Re-enables DHCP on the wired adapter, resets DNS,
  restarts the adapter, and removes the Apolloon firewall rules optionally.
.EXAMPLE
  Set-ExecutionPolicy Bypass -Scope Process -Force
  .\Revert-ApolloonDhcp.ps1
  .\Revert-ApolloonDhcp.ps1 -InterfaceAlias "Ethernet" -RemoveFirewallRules
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InterfaceAlias,
  [switch]$RemoveFirewallRules
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Run as Administrator.'
  exit 1
}

$adapter = $null
if ($InterfaceAlias) {
  $adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
} else {
  $adapter = Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
    Where-Object { $_.MediaType -match '802.3|Ethernet' } | Select-Object -First 1
  if (-not $adapter) { $adapter = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1 }
}
if (-not $adapter) { Write-Error 'No adapter found. Pass -InterfaceAlias explicitly.'; exit 1 }

Write-Host "Reverting $($adapter.Name) to DHCP..." -ForegroundColor Cyan
if ($PSCmdlet.ShouldProcess($adapter.Name, 'Enable DHCP')) {
  Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -Dhcp Enabled | Out-Null
  Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses | Out-Null
  Restart-NetAdapter -InterfaceIndex $adapter.ifIndex -Confirm:$false
  Start-Sleep -Seconds 4
  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 | Format-Table IPAddress, PrefixLength, PrefixOrigin -AutoSize

  if ($RemoveFirewallRules) {
    # The UDP rule is from versions before 4.0, which used UDP discovery.
    foreach ($name in @('Apolloon TCP 5173', 'Apolloon UDP 45737')) {
      Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
      Write-Host "Removed firewall rule: $name" -ForegroundColor DarkGray
    }
  }
  Write-Host 'Done. Adapter is DHCP again.' -ForegroundColor Green
}
