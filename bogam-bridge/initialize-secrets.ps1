param(
    [Parameter(Mandatory=$true)][string]$DeskIp,
    [Parameter(Mandatory=$true)][string]$ServerIp,
    [string]$PrivateDirectory = (Join-Path $env:LOCALAPPDATA 'InhouseBogamBridge')
)
$ErrorActionPreference = 'Stop'
$ip = [System.Net.IPAddress]::Parse($DeskIp)
[void][System.Net.IPAddress]::Parse($ServerIp)
if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 required' }
if (Test-Path -LiteralPath $PrivateDirectory) { throw 'Choose a NEW private directory; existing files are never overwritten.' }
$target = [IO.Path]::GetFullPath($PrivateDirectory)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($target.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Secrets must stay outside the repository.' }
if ($env:OneDrive -and $target.StartsWith([IO.Path]::GetFullPath($env:OneDrive), [StringComparison]::OrdinalIgnoreCase)) { throw 'Secrets must stay outside OneDrive.' }
[void](New-Item -ItemType Directory -Path $target)
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
function New-RandomHex {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
}
$token = New-RandomHex
$password = New-RandomHex
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $target 'bridge-token.txt'), $token, $utf8)
[IO.File]::WriteAllText((Join-Path $target 'pfx-password.txt'), $password, $utf8)
# Only a Windows user certificate is created. No SQL settings or ports touched.
$cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=Inhouse Bogam Bridge' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(1) -TextExtension @("2.5.29.17={text}IPAddress=$DeskIp", '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
[void](Export-PfxCertificate -Cert $cert -FilePath (Join-Path $target 'bridge.pfx') -Password (ConvertTo-SecureString $password -AsPlainText -Force))
$pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($cert.RawData, [Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n"
[IO.File]::WriteAllText((Join-Path $target 'bridge-cert.pem'), $pem, $utf8)
$config = @{
    listenHost=$DeskIp; port=8788; allowedClientIp=$ServerIp
    tokenFile=(Join-Path $target 'bridge-token.txt'); pfxFile=(Join-Path $target 'bridge.pfx')
    pfxPasswordFile=(Join-Path $target 'pfx-password.txt')
    applyEnabled=$false; mappingVerified=$false; dateStorage='UNCONFIRMED'
}
[IO.File]::WriteAllText((Join-Path $target 'bridge.json'), (ConvertTo-Json $config -Depth 5), $utf8)
Write-Host "Private configuration created at $target"
Write-Host 'No SQL connection, firewall change, service or scheduled task was created.'
