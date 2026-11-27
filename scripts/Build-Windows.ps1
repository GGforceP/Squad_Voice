param(
    [switch]$QA,
    [switch]$NoInstaller,
    [string]$StageDirectory,
    [string]$ArtifactDirectory,
    [string]$CacheDirectory,
    [string]$UpdatePublicKey
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$workspace = Split-Path -Parent $project
$cache = if ($CacheDirectory) { [IO.Path]::GetFullPath($CacheDirectory) } else { Join-Path $workspace '.cache/SquadVoice' }
$artifacts = if ($ArtifactDirectory) { [IO.Path]::GetFullPath($ArtifactDirectory) } else { Join-Path $workspace 'artifacts/SquadVoice-Public' }
$productVersion = (Get-Content -LiteralPath (Join-Path $project 'VERSION') -Raw).Trim()
if ($productVersion -cnotmatch '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$' -or
    ($productVersion.Split('.') | Where-Object { [int]$_ -gt 65535 })) { throw 'VERSION must contain a Windows-compatible major.minor.patch version.' }
$releaseName = $productVersion
$releaseFile = Join-Path $project 'installer/RELEASE'
if (Test-Path -LiteralPath $releaseFile) {
    $releaseName = (Get-Content -LiteralPath $releaseFile -Raw).Trim()
    $version = [version]$productVersion
    $expectedName = '{0}.{1}.{2}-fix' -f $version.Major, $version.Minor, ($version.Build - 1)
    if ($version.Build -eq 0 -or $releaseName -cne $expectedName) {
        throw 'installer/RELEASE must name a -fix of the preceding patch version. Remove it for a regular release.'
    }
}
$publisherModulus = ''
if ($UpdatePublicKey) {
    $publisher = Get-Content -LiteralPath $UpdatePublicKey -Raw | ConvertFrom-Json
    if ($publisher.modulus -cnotmatch '^[A-Za-z0-9+/]{512}$') { throw 'Invalid RSA-3072 publisher public key.' }
    $publisherModulus = $publisher.modulus
}
if (-not $StageDirectory) { $StageDirectory = Join-Path $workspace ('tmp/SquadVoice/build-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')) }
$stage = [IO.Path]::GetFullPath($StageDirectory)
if (Test-Path -LiteralPath $stage) { throw "Use a new staging folder: $stage" }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$wv = Join-Path $cache 'webview2-1.0.4314.35'
$wvDlls = Join-Path $wv 'lib/net462'
$fx = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$csc = Join-Path $fx 'csc.exe'
$nsis = Join-Path $cache 'nsis-3.13/nsis-3.13/makensis.exe'
if (!(Test-Path -LiteralPath $csc) -or !(Test-Path -LiteralPath $wvDlls)) { throw 'Windows .NET Framework compiler or WebView2 SDK unavailable. See README.md.' }
$ui = Join-Path $project 'ui'
Push-Location $ui
try {
    if (!(Test-Path -LiteralPath 'node_modules/typescript/bin/tsc')) {
        pnpm install --frozen-lockfile --store-dir (Join-Path $cache 'pnpm')
        if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed.' }
    }
    node './node_modules/typescript/bin/tsc' --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
    $webOutput = Join-Path $stage 'app'
    if ($QA) { node './node_modules/vite/bin/vite.js' build --mode qa --outDir $webOutput }
    else { node './node_modules/vite/bin/vite.js' build --outDir $webOutput }
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed.' }
} finally { Pop-Location }
Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(64, 64)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'
$graphics.Clear([Drawing.Color]::Transparent)
$brush = [Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.Rectangle]::new(0,0,64,64), [Drawing.Color]::FromArgb(144,150,255), [Drawing.Color]::FromArgb(84,76,216),45)
$path = [Drawing.Drawing2D.GraphicsPath]::new()
$path.AddArc(1,1,26,26,180,90); $path.AddArc(37,1,26,26,270,90); $path.AddArc(37,37,26,26,0,90); $path.AddArc(1,37,26,26,90,90); $path.CloseFigure()
$graphics.FillPath($brush,$path)
$pen = [Drawing.Pen]::new([Drawing.Color]::White,4.1)
$pen.StartCap='Round'; $pen.EndCap='Round'
foreach ($bar in @(@(18,28,37),@(25,22,43),@(32,17,48),@(39,23,42),@(46,28,37))) { $graphics.DrawLine($pen,$bar[0],$bar[1],$bar[0],$bar[2]) }
$png = [IO.MemoryStream]::new()
$bitmap.Save($png,[Drawing.Imaging.ImageFormat]::Png)
$icon = Join-Path $stage 'SquadVoice.ico'
$writer = [IO.BinaryWriter]::new([IO.File]::Create($icon))
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
    $writer.Write([byte]64); $writer.Write([byte]64); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png.ToArray())
} finally { $writer.Dispose(); $png.Dispose(); $pen.Dispose(); $path.Dispose(); $brush.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
$native = Join-Path $project 'native'
$exe = Join-Path $stage 'SquadVoice.exe'
$manifest = Join-Path $stage 'SquadVoice.manifest'
$manifestTemplate = [IO.File]::ReadAllText((Join-Path $native 'app.manifest'))
[IO.File]::WriteAllText($manifest, $manifestTemplate.Replace('version="0.0.0.0"', ('version="' + $productVersion + '.0"')))
$arguments = @('/nologo','/target:winexe','/platform:x64','/langversion:5','/codepage:65001','/optimize+',
    ('/win32manifest:'+$manifest),('/win32icon:'+$icon),('/out:'+$exe))
if ($QA) { $arguments += '/define:QA' }
foreach ($dll in @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Security.dll','System.Web.Extensions.dll')) { $arguments += '/r:'+$dll }
$arguments += '/r:'+(Join-Path $fx 'System.Net.Http.dll')
foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')) {
    $source = Join-Path $wvDlls $name
    $arguments += '/r:'+$source
    Copy-Item -LiteralPath $source -Destination $stage
}
$arguments += (Get-ChildItem -LiteralPath $native -Filter '*.cs').FullName
$buildSource = Join-Path $stage 'ReleaseBuild.g.cs'
$buildInfo = @"
using System.Reflection;
[assembly: AssemblyVersion("$productVersion.0")]
[assembly: AssemblyFileVersion("$productVersion.0")]
[assembly: AssemblyInformationalVersion("$releaseName")]
namespace SquadVoice {
    internal static class ReleaseBuild {
        internal const string Version = "$productVersion";
        internal const string DisplayVersion = "$releaseName";
        internal const string UpdateModulus = "$publisherModulus";
    }
}
"@
[IO.File]::WriteAllText($buildSource, $buildInfo)
$arguments += $buildSource
& $csc @arguments
if ($LASTEXITCODE -ne 0) { throw 'Native host compilation failed.' }
Copy-Item -LiteralPath (Join-Path $wv 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $stage
Copy-Item -LiteralPath (Join-Path $native 'SquadVoice.exe.config') -Destination $stage
Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination (Join-Path $stage 'SquadVoice-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $wv 'LICENSE.txt') -Destination (Join-Path $stage 'WebView2-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $wv 'NOTICE.txt') -Destination (Join-Path $stage 'WebView2-NOTICE.txt')
Write-Output ('STAGE=' + $stage)
if ($QA -or $NoInstaller) { exit 0 }
if (!(Test-Path -LiteralPath $nsis)) { throw 'NSIS compiler unavailable. See README.md.' }
$installer = Join-Path $artifacts ('Squad Voice ' + $releaseName + ' x64 Setup.exe')
& $nsis '/INPUTCHARSET' 'UTF8' ('/DSTAGE='+$stage) ('/DSETUP='+$installer) ('/DAPP_VERSION='+$productVersion) (Join-Path $project 'installer/SquadVoice.nsi')
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }
Get-Item -LiteralPath $installer | Select-Object FullName,Length
Get-FileHash -LiteralPath $installer -Algorithm SHA256
