param(
    [Parameter(Mandatory)][string]$KeyPath,
    [Parameter(Mandatory)][string]$PublicKeyPath,
    [switch]$Initialize,
    [string]$Installer,
    [string]$OutputDirectory,
    [switch]$Required
)

$ErrorActionPreference = 'Stop'
$publicKey = [IO.Path]::GetFullPath($PublicKeyPath)
$keyFile = [IO.Path]::GetFullPath($KeyPath)
$encoding = [Text.UTF8Encoding]::new($false)
$entropy = $encoding.GetBytes('Squad Voice Windows release signing v1')
$provider = [Security.Cryptography.CspParameters]::new(24)
$provider.Flags = [Security.Cryptography.CspProviderFlags]::CreateEphemeralKey

if ($Initialize) {
    if ((Test-Path -LiteralPath $keyFile) -or (Test-Path -LiteralPath $publicKey)) {
        throw 'The publisher already exists. Keep its key for future versions.'
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $keyFile) | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $publicKey) | Out-Null
    $rsa = [Security.Cryptography.RSACryptoServiceProvider]::new(3072, $provider)
    $rsa.PersistKeyInCsp = $false
    try {
        $private = $rsa.ExportCspBlob($true)
        try {
            $protected = [Security.Cryptography.ProtectedData]::Protect($private, $entropy, 'CurrentUser')
            [IO.File]::WriteAllBytes($keyFile, $protected)
        } finally { [Array]::Clear($private, 0, $private.Length) }
        $params = $rsa.ExportParameters($false)
        $key = @{ modulus = [Convert]::ToBase64String($params.Modulus) } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($publicKey, $key + "`n", $encoding)
    } finally { $rsa.Dispose() }
    return
}

if (!$Installer -or !$OutputDirectory) { throw 'Provide the built installer and output directory.' }
$package = Get-Item -LiteralPath $Installer
$version = $package.VersionInfo.ProductVersion
if ($package.VersionInfo.ProductName -ne 'Squad Voice' -or $package.VersionInfo.FileDescription -ne 'Squad Voice Portable Installer' -or
    $version -cnotmatch '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$' -or
    $package.Length -lt 1 -or $package.Length -gt 32MB) { throw 'The file is not a supported Squad Voice installer.' }

$sha = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$name = 'SquadVoice-' + $version + '-x64.exe'
$release = [ordered]@{
    platform = 'win-x64'
    version = $version
    file = $name
    sha256 = $sha
    size = $package.Length
    required = $Required.IsPresent
} | ConvertTo-Json -Compress
$payload = $encoding.GetBytes($release)
$rsa = [Security.Cryptography.RSACryptoServiceProvider]::new(3072, $provider)
$rsa.PersistKeyInCsp = $false
$private = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyFile), $entropy, 'CurrentUser')
try {
    $rsa.ImportCspBlob($private)
    $expected = (Get-Content -LiteralPath $publicKey -Raw | ConvertFrom-Json).modulus
    if ([Convert]::ToBase64String($rsa.ExportParameters($false).Modulus) -cne $expected) { throw 'The signing key does not match the app publisher.' }
    $signature = $rsa.SignData($payload, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
} finally {
    [Array]::Clear($private, 0, $private.Length)
    $rsa.Dispose()
}

$directory = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
$destination = Join-Path $directory $name
if (Test-Path -LiteralPath $destination) {
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) {
        throw 'This version already refers to another installer.'
    }
} else { [IO.File]::Copy($package.FullName, $destination) }
$manifest = Join-Path $directory 'release.json'
$temporary = $manifest + '.' + [Guid]::NewGuid().ToString('N')
try {
    $envelope = @{ payload = [Convert]::ToBase64String($payload); signature = [Convert]::ToBase64String($signature) } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($temporary, $envelope + "`n", $encoding)
    [IO.File]::Move($temporary, $manifest, $true)
} finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
Get-Item -LiteralPath $manifest,$destination | Select-Object Name,Length
