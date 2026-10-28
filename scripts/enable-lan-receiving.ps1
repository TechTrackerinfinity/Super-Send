[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [ValidateRange(0, 65535)][int]$Port = 0,
    [string]$RemoteAddress = 'LocalSubnet',
    [ValidateSet('Private', 'Public', 'Private,Public')][string]$ProfileNames = 'Private',
    [string]$ResultPath,
    [switch]$Plan,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$Profiles = $ProfileNames.Split(',')
function Save-Result($Value) {
    $json = $Value | ConvertTo-Json -Depth 5
    if ($ResultPath) { [IO.File]::WriteAllText($ResultPath, $json) }
    Write-Output $json
}
try {
    $program = (Resolve-Path -LiteralPath $ExecutablePath).ProviderPath
    if ((Split-Path -Leaf $program) -ne 'LocalSend Rebuilt.exe' -or $program -match '["\r\n]') {
        throw 'Select the LocalSend Rebuilt.exe from the extracted application folder.'
    }
    if ($ResultPath -and (-not [IO.Path]::IsPathRooted($ResultPath) -or $ResultPath -match '["\r\n]')) { throw 'Use an absolute result path.' }
    if ($RemoteAddress -ne 'LocalSubnet') {
        $peerAddress = $null
        if (-not [Net.IPAddress]::TryParse($RemoteAddress, [ref]$peerAddress) -or $peerAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Use LocalSubnet or one IPv4 address.' }
    }
    if ($Port -eq 0) {
        $processIds = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $program -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId)
        $ports = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $processIds -and $_.LocalAddress -in @('0.0.0.0', '::') } | Select-Object -ExpandProperty LocalPort -Unique)
        if ($ports.Count -ne 1) { throw 'Open this copy of LocalSend Rebuilt first, then retry Enable LAN receiving.' }
        $Port = $ports[0]
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $pathId = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($program.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
    finally { $hash.Dispose() }
    $rules = @(@{ Name = "LocalSend-Rebuilt-$pathId-Receive"; DisplayName = 'LocalSend Rebuilt - LAN transfers'; Protocol = 'TCP'; LocalPort = [string]$Port })
    if ($Plan) {
        Save-Result @{ applied = $false; program = $program; direction = 'Inbound'; action = 'Allow'; remoteAddress = $RemoteAddress; profiles = $Profiles; rules = $rules }
        exit 0
    }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        if ($Elevated) { throw 'Windows administrator approval is required to enable LAN receiving.' }
        $profileArgument = $Profiles -join ','
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ExecutablePath "' + $program + '" -Port ' + $Port + ' -RemoteAddress "' + $RemoteAddress + '" -ProfileNames "' + $profileArgument + '" -Elevated'
        if ($ResultPath) { $arguments += ' -ResultPath "' + $ResultPath + '"' }
        $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw 'Windows did not enable LAN receiving. Approve the administrator prompt and try again.' }
        exit 0
    }
    foreach ($rule in $rules) {
        $scope = @{ Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'; Profile = $Profiles; Program = $program; Protocol = $rule.Protocol; LocalPort = $rule.LocalPort; RemoteAddress = $RemoteAddress; EdgeTraversalPolicy = 'Block' }
        if (Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue) {
            Set-NetFirewallRule -Name $rule.Name @scope | Out-Null
        } else {
            New-NetFirewallRule -Name $rule.Name -DisplayName $rule.DisplayName -Description 'Allow this LocalSend Rebuilt executable to receive from devices on the local subnet.' @scope | Out-Null
        }
    }
    Save-Result @{ applied = $true; program = $program; port = $Port; rules = @($rules.Name); remoteAddress = $RemoteAddress; profiles = $Profiles }
    exit 0
} catch {
    Save-Result @{ applied = $false; error = $_.Exception.Message }
    exit 1
}
