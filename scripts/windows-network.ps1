[CmdletBinding()]
param(
    [ValidateSet('Status','Apply','Remove','Plan')][string]$Action = 'Status',
    [string]$Program,
    [string]$PreviousProgram,
    [ValidateRange(0,65535)][int]$Port = 0,
    [ValidateSet('Private','Private,Public')][string]$Profiles = 'Private',
    [string]$ResultPath,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

function Test-LanAdministrator {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-LanRule([string]$Store,[string]$RuleName) {
    $queryErrors=@()
    $found=Get-NetFirewallRule -PolicyStore $Store -Name $RuleName -ErrorAction SilentlyContinue -ErrorVariable queryErrors
    foreach ($failure in $queryErrors) { if ($failure.CategoryInfo.Category -ne 'ObjectNotFound') { throw $failure } }
    return $found
}
function New-LanPlan([string]$AppPath, [int]$ListenPort, [string]$NetworkProfiles, [bool]$RequireFile=$true) {
    if (-not [IO.Path]::IsPathRooted($AppPath)) { throw 'Use the full application path.' }
    $resolved = [IO.Path]::GetFullPath($AppPath)
    if ($RequireFile) { $resolved=(Resolve-Path -LiteralPath $AppPath).ProviderPath }
    if ((Split-Path -Leaf $resolved) -ne 'LocalSend Rebuilt.exe' -or $resolved -match '["\r\n]') { throw 'Open the packaged LocalSend Rebuilt app to configure receiving.' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($resolved.ToLowerInvariant())))).Replace('-','').Substring(0,16) }
    finally { $hash.Dispose() }
    return @{
        program=$resolved; port=$ListenPort; profiles=@($NetworkProfiles.Split(',')); remoteAddress='LocalSubnet'; group='LocalSend Rebuilt'
        rules=@(
            @{name="LocalSend-Rebuilt-$id-TCP"; protocol='TCP'; localPort=[string]$ListenPort; label='LocalSend Rebuilt - receiving'},
            @{name="LocalSend-Rebuilt-$id-UDP"; protocol='UDP'; localPort='53317'; label='LocalSend Rebuilt - discovery'}
        )
        legacy="LocalSend-Rebuilt-$id-Receive"
    }
}
function Get-LanOwnedRules($Plan) {
    foreach ($name in @($Plan.rules.name) + @($Plan.legacy)) {
        $rule=Get-LanRule 'PersistentStore' $name
        if ($rule) {
            $application=$rule | Get-NetFirewallApplicationFilter
            if ($application.Program -ieq $Plan.program) { $rule }
        }
    }
}
function Get-LanStatus($Plan) {
    $private=@(); $public=@(); $anyOwned=$false
    foreach ($expected in $Plan.rules) {
        $rule=Get-LanRule 'ActiveStore' $expected.name
        $privateGood=$false; $publicGood=$false
        if ($rule) {
            $anyOwned=$true
            $application=$rule | Get-NetFirewallApplicationFilter
            $ports=$rule | Get-NetFirewallPortFilter
            $address=$rule | Get-NetFirewallAddressFilter
            $protocol=[string]$ports.Protocol
            $correct=$application.Program -ieq $Plan.program -and [string]$rule.Enabled -eq 'True' -and [string]$rule.Action -eq 'Allow' -and [string]$rule.Direction -eq 'Inbound' -and
                ($protocol -eq $expected.protocol -or ($protocol -eq '6' -and $expected.protocol -eq 'TCP') -or ($protocol -eq '17' -and $expected.protocol -eq 'UDP')) -and
                @($ports.LocalPort).Count -eq 1 -and [string]$ports.LocalPort -eq $expected.localPort -and @($address.RemoteAddress).Count -eq 1 -and [string]$address.RemoteAddress -eq 'LocalSubnet'
            if ($correct) {
                $names=([string]$rule.Profile) -split ',\s*'
                $privateGood=$names -contains 'Private'
                $publicGood=$names -contains 'Public'
            }
        }
        $private += $privateGood; $public += $publicGood
    }
    $networks=@(Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object { @{name=$_.Name; category=[string]$_.NetworkCategory} })
    $blocked=@()
    $applicationRules=@(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program $Plan.program -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue)
    foreach ($rule in $applicationRules) {
        $ruleProfiles=([string]$rule.Profile) -split ',\s*'
        $activeProfiles=@($networks | ForEach-Object { if ($_.category -eq 'DomainAuthenticated') {'Domain'}else{$_.category} })
        $applies=$ruleProfiles -contains 'Any' -or @($activeProfiles | Where-Object { $ruleProfiles -contains $_ }).Count -gt 0
        if ($applies -and [string]$rule.Enabled -eq 'True' -and [string]$rule.Direction -eq 'Inbound' -and [string]$rule.Action -eq 'Block') { $blocked += $rule.DisplayName }
    }
    $policyBlocked=@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -eq 'True' -and ([string]$_.AllowInboundRules -eq 'False' -or [string]$_.AllowLocalFirewallRules -eq 'False') } | Select-Object -ExpandProperty Name)
    return @{
        privateAllowed=($private.Count -eq 2 -and $private -notcontains $false)
        publicAllowed=($public.Count -eq 2 -and $public -notcontains $false)
        anyOwned=$anyOwned; networks=$networks; blocks=$blocked; policyBlocked=$policyBlocked; port=$Plan.port
    }
}
function Set-LanAccess($Plan) {
    if ($Plan.port -lt 1) { throw 'The receiver must be running before enabling access.' }
    foreach ($rule in $Plan.rules) {
        $existing=Get-LanRule 'PersistentStore' $rule.name
        $scope=@{Direction='Inbound'; Action='Allow'; Enabled='True'; Profile=$Plan.profiles; Program=$Plan.program; Protocol=$rule.protocol; LocalPort=$rule.localPort; RemoteAddress='LocalSubnet'; EdgeTraversalPolicy='Block'}
        if ($existing) {
            $application=$existing | Get-NetFirewallApplicationFilter
            if ($application.Program -ine $Plan.program) { throw 'A different application owns this firewall rule. Contact your administrator.' }
            Set-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name @scope | Out-Null
        } else {
            New-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name -DisplayName $rule.label -Group $Plan.group -Description 'Nearby devices on the local subnet only. Managed by LocalSend Rebuilt receiving setup.' @scope | Out-Null
        }
    }
    foreach ($rule in @(Get-LanOwnedRules $Plan | Where-Object { $_.Name -eq $Plan.legacy })) { $rule | Remove-NetFirewallRule | Out-Null }
}
function Remove-LanAccess($Plan) {
    foreach ($rule in @(Get-LanOwnedRules $Plan)) { $rule | Remove-NetFirewallRule | Out-Null }
}
function Write-LanResult($Value) {
    $json=$Value | ConvertTo-Json -Depth 8 -Compress
    if ($ResultPath) { [IO.File]::WriteAllText($ResultPath,$json,[Text.UTF8Encoding]::new($false)) }
    Write-Output $json
}

# Dot-sourcing exposes the policy functions for tests with in-memory NetSecurity commands.
if ($MyInvocation.InvocationName -ne '.') {
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
    try {
        if ($ResultPath -and (-not [IO.Path]::IsPathRooted($ResultPath) -or $ResultPath -match '["\r\n]')) { throw 'Invalid setup result path.' }
        $plan=New-LanPlan $Program $Port $Profiles ($Action -ne 'Remove')
        $previous=$null
        if ($PreviousProgram -and $PreviousProgram -ine $plan.program) { $previous=New-LanPlan $PreviousProgram $Port $Profiles $false }
        if ($Action -eq 'Apply' -and $Port -lt 1) { throw 'Start the receiver before enabling access.' }
        if ($Action -eq 'Plan') { Write-LanResult @{ok=$true; applied=$false; plan=$plan}; exit 0 }
        if ($Action -eq 'Status') { Write-LanResult @{ok=$true; status=(Get-LanStatus $plan)}; exit 0 }
        # Uninstall with no owned rules needs no elevation and changes no firewall settings.
        if ($Action -eq 'Remove' -and @(Get-LanOwnedRules $plan).Count -eq 0) { Write-LanResult @{ok=$true; removed=$true}; exit 0 }
        if (-not (Test-LanAdministrator)) {
            if ($Elevated) { throw 'Administrator approval is required to configure Windows receiving.' }
            if (-not $ResultPath) { throw 'A result file is required for administrator approval.' }
            $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Action '+$Action+' -Program "'+$plan.program+'" -Port '+$Port+' -Profiles "'+$Profiles+'" -ResultPath "'+$ResultPath+'" -Elevated'
            if ($previous) { $arguments+=' -PreviousProgram "'+$previous.program+'"' }
            try { $child=Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru }
            catch { Write-LanResult @{ok=$false; code='cancelled'; message='Windows approval was cancelled. Receiving setup has not changed.'}; exit 1 }
            if (Test-Path -LiteralPath $ResultPath) { Write-Output ([IO.File]::ReadAllText($ResultPath)) }
            else { Write-LanResult @{ok=$false; code='failed'; message='Windows did not return a setup result. Check your administrator policy.'} }
            exit $child.ExitCode
        }
        if ($Action -eq 'Apply') { Set-LanAccess $plan; if ($previous) { Remove-LanAccess $previous }; Write-LanResult @{ok=$true; applied=$true} }
        elseif ($Action -eq 'Remove') { Remove-LanAccess $plan; Write-LanResult @{ok=$true; removed=$true} }
        exit 0
    } catch { Write-LanResult @{ok=$false; code='failed'; message=$_.Exception.Message}; exit 1 }
}
