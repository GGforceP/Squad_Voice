param([switch]$SkipLiveKit, [string]$CacheDirectory)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent ((Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath)
$cache = if ($CacheDirectory) { [IO.Path]::GetFullPath($CacheDirectory) } else { Join-Path $workspace '.cache/SquadVoice' }
New-Item -ItemType Directory -Force -Path $cache | Out-Null

function Get-VerifiedArchive([string]$FileName, [string]$Uri, [string]$SHA256, [string]$Expanded, [string]$Required) {
    $archive = Join-Path $cache $FileName
    $folder = Join-Path $cache $Expanded
    if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $SHA256) {
        Invoke-WebRequest -Uri $Uri -OutFile $archive -TimeoutSec 120
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $SHA256) { throw ('SHA256 mismatch: ' + $FileName) }
    if (!(Test-Path -LiteralPath (Join-Path $folder $Required))) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        tar.exe -xf $archive -C $folder
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $folder $Required))) { throw ('Could not extract ' + $FileName) }
    }
    Write-Output ('Verified ' + $FileName)
}

Get-VerifiedArchive 'webview2-1.0.4314.35.nupkg' 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg' '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4' 'webview2-1.0.4314.35' 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
Get-VerifiedArchive 'nsis-3.13.zip' 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip' 'BA63DFFC4410EE89193E1CB5A41989991BD77C61068DA17E3156D136B7B0B3D8' 'nsis-3.13' 'nsis-3.13/makensis.exe'
if (!$SkipLiveKit) {
    Get-VerifiedArchive 'livekit_1.13.11_windows_amd64.zip' 'https://github.com/livekit/livekit/releases/download/v1.13.11/livekit_1.13.11_windows_amd64.zip' '5D071EA43339F0140D24A66F0B2FF8A7BF6C4D0DCEB19B30ABCA835670213667' 'livekit-1.13.11' 'livekit-server.exe'
}
