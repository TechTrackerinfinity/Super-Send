$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\scripts\windows-network.ps1"
$script:Rules=@{}
$script:Count=0
function Assert-Policy($Condition,[string]$Message){if(-not $Condition){throw $Message};$script:Count++}
function Get-NetFirewallRule {
    [CmdletBinding()]param([string]$PolicyStore,[string]$Name,[Parameter(ValueFromPipeline)]$InputObject)
    process {if($Name){if($script:Rules.ContainsKey($Name)){$script:Rules[$Name]}}elseif($InputObject){if($script:Rules.ContainsKey($InputObject.Name)){$script:Rules[$InputObject.Name]}}}
}
function Get-NetFirewallApplicationFilter {
    [CmdletBinding()]param([string]$PolicyStore,[string]$Program,[Parameter(ValueFromPipeline)]$InputObject)
    process {if($Program){foreach($rule in $script:Rules.Values){if($rule.Program -eq $Program){[pscustomobject]@{Name=$rule.Name;Program=$rule.Program}}}}elseif($InputObject){[pscustomobject]@{Program=$InputObject.Program}}}
}
function Get-NetFirewallPortFilter {param([Parameter(ValueFromPipeline)]$InputObject)process{[pscustomobject]@{Protocol=$InputObject.Protocol;LocalPort=$InputObject.LocalPort}}}
function Get-NetFirewallAddressFilter {param([Parameter(ValueFromPipeline)]$InputObject)process{[pscustomobject]@{RemoteAddress=$InputObject.RemoteAddress}}}
function New-NetFirewallRule {
    param($PolicyStore,$Name,$DisplayName,$Group,$Description,$Direction,$Action,$Enabled,$Profile,$Program,$Protocol,$LocalPort,$RemoteAddress,$EdgeTraversalPolicy)
    $script:Rules[$Name]=[pscustomobject]@{Name=$Name;DisplayName=$DisplayName;Program=$Program;Protocol=$Protocol;LocalPort=$LocalPort;RemoteAddress=$RemoteAddress;Profile=($Profile -join ', ');Enabled=$Enabled;Action=$Action;Direction=$Direction}
}
function Set-NetFirewallRule {
    param($PolicyStore,$Name,$Direction,$Action,$Enabled,$Profile,$Program,$Protocol,$LocalPort,$RemoteAddress,$EdgeTraversalPolicy)
    New-NetFirewallRule -Name $Name -DisplayName 'Updated' -Direction $Direction -Action $Action -Enabled $Enabled -Profile $Profile -Program $Program -Protocol $Protocol -LocalPort $LocalPort -RemoteAddress $RemoteAddress
}
function Remove-NetFirewallRule {param([Parameter(ValueFromPipeline)]$InputObject)process{$script:Rules.Remove($InputObject.Name)}}
function Get-NetConnectionProfile {[CmdletBinding()]param() [pscustomobject]@{Name='Test Wi-Fi';NetworkCategory='Public'}}
function Get-NetFirewallProfile {param($PolicyStore)[pscustomobject]@{Name='Public';Enabled='True';AllowInboundRules='True';AllowLocalFirewallRules='True'}}

$program=Join-Path $PSScriptRoot '..\release\LocalSend-Rebuilt-1.1.1-win32-x64\LocalSend Rebuilt.exe'
if(-not (Test-Path -LiteralPath $program)){$program=Join-Path $PSScriptRoot 'fixtures\LocalSend Rebuilt.exe';New-Item -ItemType Directory -Force (Split-Path -Parent $program)|Out-Null;[IO.File]::WriteAllText($program,'Test path only; never executed')}
$plan=New-LanPlan $program 59807 'Private'
Assert-Policy ($plan.profiles.Count -eq 1 -and $plan.profiles[0] -eq 'Private') 'Private must be the default profile'
Assert-Policy ($plan.remoteAddress -eq 'LocalSubnet') 'Remote scope must be LocalSubnet'
Set-LanAccess $plan
Assert-Policy ($script:Rules.Count -eq 2) 'Exactly TCP and UDP rules must be created'
Assert-Policy ($script:Rules[$plan.rules[0].name].LocalPort -eq '59807') 'TCP rule must use actual port'
Assert-Policy ($script:Rules[$plan.rules[1].name].LocalPort -eq '53317') 'UDP discovery port must be fixed'
$status=Get-LanStatus $plan
Assert-Policy ($status.privateAllowed -and -not $status.publicAllowed) 'Private must be verified without enabling Public'
$changed=New-LanPlan $program 53318 'Private,Public';Set-LanAccess $changed
Assert-Policy ($script:Rules.Count -eq 2 -and $script:Rules[$plan.rules[0].name].LocalPort -eq '53318') 'Port repair must update the same rules'
$status=Get-LanStatus $changed
Assert-Policy ($status.privateAllowed -and $status.publicAllowed) 'Explicit Public choice must be verified'
Set-LanAccess (New-LanPlan $program 53318 'Private')
$status=Get-LanStatus $changed
Assert-Policy (-not $status.publicAllowed) 'Disabling Public must narrow existing rules'
$script:Rules[$changed.rules[0].name].RemoteAddress='Any'
Assert-Policy (-not (Get-LanStatus $changed).privateAllowed) 'A broader rule must not be treated as verified setup'
Set-LanAccess $changed
$other=[pscustomobject]@{Name='Other-app';DisplayName='Other app';Program='C:\Other.exe';Action='Allow';Direction='Inbound';Enabled='True'}
$script:Rules[$other.Name]=$other
$legacy=[pscustomobject]@{Name=$changed.legacy;Program=$changed.program}
$script:Rules[$legacy.Name]=$legacy
Set-LanAccess $changed
Assert-Policy (-not $script:Rules.ContainsKey($changed.legacy)) 'Legacy owned rule should be retired'
Remove-LanAccess $changed
Assert-Policy ($script:Rules.Count -eq 1 -and $script:Rules.ContainsKey('Other-app')) 'Uninstall must preserve unrelated rules'
$script:Rules[$changed.rules[0].name]=[pscustomobject]@{Name=$changed.rules[0].name;Program='C:\Other.exe'}
$refused=$false;try{Set-LanAccess $changed}catch{$refused=$true}
Assert-Policy $refused 'Rule ownership collision must be refused'
$old=New-LanPlan 'C:\Previously installed\LocalSend Rebuilt.exe' 53318 'Private' $false
Assert-Policy ($old.program -eq 'C:\Previously installed\LocalSend Rebuilt.exe') 'Cleanup must work when the old executable was already moved or removed'
$script:Rules[$old.rules[0].name]=[pscustomobject]@{Name=$old.rules[0].name;Program=$old.program}
Remove-LanAccess $old
Assert-Policy (-not $script:Rules.ContainsKey($old.rules[0].name)) 'Previous path cleanup must remove its own stale rule'
$block=[pscustomobject]@{Name='App-block';DisplayName='App block';Program=$changed.program;Profile='Private';Action='Block';Enabled='True';Direction='Inbound'}
$script:Rules[$block.Name]=$block
Assert-Policy ((Get-LanStatus $changed).blocks.Count -eq 0) 'An inactive profile block must not block the current Public network'
$block.Profile='Public'
Assert-Policy ((Get-LanStatus $changed).blocks.Count -eq 1) 'An active profile block must be surfaced'
Write-Output "Firewall policy tests passed: $script:Count assertions. All NetSecurity commands were simulated; no Windows rules were changed."
