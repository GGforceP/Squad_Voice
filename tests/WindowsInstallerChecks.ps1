param(
    [Parameter(Mandatory)][string]$StageDirectory,
    [Parameter(Mandatory)][string]$TestDirectory,
    [string]$PreviousStageDirectory,
    [string]$CacheDirectory
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$stage = (Resolve-Path -LiteralPath $StageDirectory).ProviderPath
$previous = if ($PreviousStageDirectory) { (Resolve-Path -LiteralPath $PreviousStageDirectory).ProviderPath } else { $stage }
$previousExe = Get-Item -LiteralPath (Join-Path $previous 'SquadVoice.exe')
$previousVersion = ([version]$previousExe.VersionInfo.FileVersion).ToString(3)
$exeHash = (Get-FileHash -LiteralPath (Join-Path $stage 'SquadVoice.exe')).Hash
$root = [IO.Path]::GetFullPath($TestDirectory)
if (Test-Path -LiteralPath $root) { throw "Use a new test directory: $root" }
if (!$CacheDirectory) { $CacheDirectory = Join-Path (Split-Path -Parent $project) '.cache/SquadVoice' }
$nsis = Join-Path $CacheDirectory 'nsis-3.13/nsis-3.13/makensis.exe'
$source = Join-Path $project 'installer/SquadVoice.nsi'
$version = (Get-Content -LiteralPath (Join-Path $project 'VERSION') -Raw).Trim()
$shell = New-Object -ComObject WScript.Shell
$standard = 'SquadVoice.lnk'
$legacy = 'Squad Voice.lnk'
$custom = 'Gaming group.lnk'
$otherProgram = Join-Path $env:WINDIR 'notepad.exe'
$cases = @(
    @{ Name = 'existing'; Links = @{ $standard = 'app' }; Expected = @($standard) },
    @{ Name = 'duplicate'; Links = @{ $standard = 'app'; $legacy = 'app'; $custom = 'other' }; Expected = @($standard, $custom); Uninstall = $true },
    @{ Name = 'manual-upgrade'; Links = @{ $standard = 'app'; $legacy = 'app' }; Expected = @($standard); Manual = $true },
    @{ Name = 'legacy-only'; Links = @{ $legacy = 'app' }; Expected = @($standard) },
    @{ Name = 'renamed'; Links = @{ $custom = 'app' }; Expected = @($custom) },
    @{ Name = 'renamed-duplicate'; Links = @{ $custom = 'app'; $legacy = 'app' }; Expected = @($custom) },
    @{ Name = 'name-in-use'; Links = @{ $standard = 'other'; $legacy = 'app' }; Expected = @($standard, $legacy) },
    @{ Name = 'no-shortcut'; Links = @{}; Expected = @($standard) },
    @{ Name = 'manual-install'; Links = @{}; Expected = @(); Manual = $true }
)

foreach ($case in $cases) {
    $caseRoot = Join-Path $root $case.Name
    $desktop = Join-Path $caseRoot 'Desktop'
    $documents = Join-Path $caseRoot 'Documents'
    $install = Join-Path $caseRoot 'Installed Squad Voice'
    $exe = Join-Path $install 'SquadVoice.exe'
    $data = Join-Path $install 'Data'
    $metadata = Join-Path $documents 'Squad Voice/installation.txt'
    New-Item -ItemType Directory -Path $desktop,$documents -Force | Out-Null
    if ($case.Name -ne 'manual-install') {
        New-Item -ItemType Directory -Path $data,(Join-Path $install 'app'),(Split-Path -Parent $metadata) -Force | Out-Null
        Copy-Item -LiteralPath $previousExe.FullName -Destination $exe
        Copy-Item -LiteralPath (Join-Path $previous 'app/index.html') -Destination (Join-Path $install 'app/index.html')
        Set-Content -LiteralPath $metadata -Value $install,$previousVersion -Encoding Unicode
        Set-Content -LiteralPath (Join-Path $data 'upgrade-marker.txt') -Value 'existing data'
    }

    $original = @{}
    foreach ($name in $case.Links.Keys) {
        $path = Join-Path $desktop $name
        $link = $shell.CreateShortcut($path)
        $link.TargetPath = if ($case.Links[$name] -eq 'app') { $exe } else { $otherProgram }
        $link.Arguments = '--existing-shortcut'
        $link.WorkingDirectory = $caseRoot
        $link.Save()
        $original[$name] = (Get-FileHash -LiteralPath $path).Hash
    }

    $setup = Join-Path $caseRoot 'TestSetup.exe'
    & $nsis '/V2' '/INPUTCHARSET' 'UTF8' "/DSTAGE=$stage" "/DSETUP=$setup" "/DAPP_VERSION=$version" "/DTEST_DOCUMENTS=$documents" "/DTEST_DESKTOP=$desktop" $source
    if ($LASTEXITCODE -ne 0) { throw "Failed to compile test installer for $($case.Name)." }
    $options = if ($case.Manual) { '/S' } else { '/S /UPDATE' }
    $result = Start-Process -FilePath $setup -ArgumentList "$options /D=$install" -PassThru -Wait -WindowStyle Hidden
    if ($result.ExitCode -ne 0) { throw "Failed to install in $($case.Name): $($result.ExitCode)." }
    $record = Get-Content -LiteralPath $metadata -Encoding Unicode
    if ($record[0] -ne $install -or $record[1] -ne $version) { throw "Installation record is incorrect in $($case.Name)." }
    if ((Get-FileHash -LiteralPath $exe).Hash -ne $exeHash) { throw "Client executable was not installed in $($case.Name)." }
    if ($case.Name -ne 'manual-install' -and (Get-Content -LiteralPath (Join-Path $data 'upgrade-marker.txt')) -ne 'existing data') {
        throw "Existing data was not preserved in $($case.Name)."
    }

    $links = @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -File)
    if ((($links.Name | Sort-Object) -join '|') -cne (($case.Expected | Sort-Object) -join '|')) {
        throw "Unexpected shortcut names in $($case.Name): $($links.Name -join ', ')."
    }
    foreach ($link in $links) {
        $initialName = if ($case.Name -eq 'legacy-only') { $legacy } else { $link.Name }
        if ($original.ContainsKey($initialName)) {
            if ((Get-FileHash -LiteralPath $link.FullName).Hash -ne $original[$initialName]) {
                throw "Existing shortcut $initialName was rewritten in $($case.Name)."
            }
        } elseif ($shell.CreateShortcut($link.FullName).TargetPath -ne $exe) {
            throw "New shortcut targets the wrong executable in $($case.Name)."
        }
    }

    if ($case.Uninstall) {
        Copy-Item -LiteralPath (Join-Path $desktop $standard) -Destination (Join-Path $desktop $legacy)
        $result = Start-Process -FilePath (Join-Path $install 'Uninstall.exe') -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
        $remaining = @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -File)
        if ($result.ExitCode -ne 0 -or $remaining.Count -ne 1 -or $remaining[0].Name -ne $custom -or
            (Get-FileHash -LiteralPath $remaining[0].FullName).Hash -ne $original[$custom]) {
            throw 'Uninstall did not remove only the two owned shortcuts.'
        }
    }
    Write-Output "Installer check passed: $($case.Name)"
}
