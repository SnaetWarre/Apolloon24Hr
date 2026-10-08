# The inbound firewall rules the linked laptops need: TCP 5173 (app and laptops) and UDP 45737
# (laptops finding each other), on every network type, because Windows counts an event router
# without internet as a public network. The Windows installer runs this (build/installer.nsh).
# The display names match Vast netwerkadres (server/net-setup.ts) and public/event-network/,
# so those scripts find the same rules and Revert-ApolloonDhcp.ps1 removes them.
#
#   check <exe>   exit 0 when nothing needs to change, 1 when 'add' does; works without admin
#   present       exit 0 when one of the rules exists; works without admin
#   add <exe>     needs admin
#   remove        needs admin
param(
  [Parameter(Mandatory = $true)][ValidateSet('check', 'present', 'add', 'remove')][string]$Action,
  [string]$Program
)

$ErrorActionPreference = 'Stop'
$rules = @(
  @{ Name = 'Apolloon TCP 5173'; Protocol = 'TCP'; Port = 5173 },
  @{ Name = 'Apolloon UDP 45737'; Protocol = 'UDP'; Port = 45737 }
)

# Windows' own "Allow access?" question blocks the app on every network type left unticked
# (public, by default), and a block rule wins over every allow rule. Windows writes that path in
# lower case, so compare with -eq, which ignores case.
function Get-AppBlockRules {
  $filters = @(Get-NetFirewallApplicationFilter | Where-Object {
      [Environment]::ExpandEnvironmentVariables($_.Program) -eq $Program
    })
  if ($filters.Count -eq 0) { return }
  $filters | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
}

switch ($Action) {
  'check' {
    foreach ($rule in $rules) {
      $existing = @(Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)
      if ($existing.Count -eq 0) { exit 1 }
      # A rule from Vast netwerkadres has no program; one for an older install folder is stale.
      foreach ($filter in ($existing | Get-NetFirewallApplicationFilter)) {
        if ($filter.Program -notin 'Any', $Program) { exit 1 }
      }
    }
    if (@(Get-AppBlockRules).Count -gt 0) { exit 1 }
    exit 0
  }
  'present' {
    foreach ($rule in $rules) {
      if (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue) { exit 0 }
    }
    exit 1
  }
  'add' {
    foreach ($rule in $rules) {
      Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
      New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol $rule.Protocol -LocalPort $rule.Port -Program $Program -Action Allow -Profile Any | Out-Null
    }
    # By name: Remove-NetFirewallRule without one would remove every rule on the laptop.
    $blocks = @(Get-AppBlockRules)
    if ($blocks.Count -gt 0) { Remove-NetFirewallRule -Name $blocks.Name }
  }
  'remove' {
    foreach ($rule in $rules) {
      Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    }
  }
}
