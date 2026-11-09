# Run from the source checkout. Build products stay in the local workspace.
[CmdletBinding()]
param(
    [string]$BuildRoot = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'ChatGPT\yaoc'),
    [switch]$Msix,
    [switch]$Official,
    [switch]$Sign,
    [string]$CertificateThumbprint = $env:YAOC_AUTHENTICODE_THUMBPRINT
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot).TrimEnd('\')
if ($BuildRoot.StartsWith('\\') -or ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($BuildRoot))).DriveType -ne 'Fixed') {
    throw 'BuildRoot must be on a local fixed drive.'
}
if ($BuildRoot -eq $sourceRoot -or $BuildRoot.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'BuildRoot must be outside the source checkout.'
}
$marker = Join-Path $BuildRoot '.yaoc-build-workspace'
if ((Test-Path -LiteralPath $BuildRoot) -and !(Test-Path -LiteralPath $marker) -and @(Get-ChildItem -LiteralPath $BuildRoot -Force).Count -gt 0) {
    throw 'BuildRoot is not an empty directory or an established YAOC build workspace.'
}
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
Set-Content -LiteralPath $marker -Value $sourceRoot
$metadata = @('package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'THIRD_PARTY_LICENSES.txt')
$sourceHashes = @{}
foreach ($file in $metadata) {
    $sourceHashes[$file] = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $file) -Algorithm SHA256).Hash
}
# Never copy network dependencies, compiler caches, binaries, or private Git state.
robocopy $sourceRoot $BuildRoot /MIR /XD .git node_modules dist dist-ssr target release .local output signing-test /XF *.log .yaoc-build-workspace /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw "Source copy failed ($LASTEXITCODE)." }
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:LOCALAPPDATA\Programs\llvm-mingw\bin;" + $env:PATH
# Ensure caller overrides cannot redirect compilation back to a network cache.
$oldThumbprint = $env:YAOC_AUTHENTICODE_THUMBPRINT
$oldSignTool = $env:TAURI_WINDOWS_SIGNTOOL_PATH
$oldTarget = $env:CARGO_TARGET_DIR
$oldOfficialTest = $env:YAOC_TEST_OFFICIAL
$env:YAOC_TEST_OFFICIAL = if ($Official) { '1' } else { '0' }
$env:CARGO_TARGET_DIR = Join-Path $BuildRoot 'src-tauri\target'
Push-Location $BuildRoot
try {
    if ($Sign -or $CertificateThumbprint) {
        $certificates = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object {
            $_.HasPrivateKey -and $_.NotBefore -le (Get-Date) -and $_.NotAfter -gt (Get-Date)
        })
        if ($CertificateThumbprint) {
            $CertificateThumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
            $certificates = @($certificates | Where-Object Thumbprint -eq $CertificateThumbprint)
        }
        if ($certificates.Count -ne 1) {
            throw 'Connect SimplySign Desktop. Exactly one valid code-signing certificate is required; use -CertificateThumbprint to select one if needed.'
        }
        $env:YAOC_AUTHENTICODE_THUMBPRINT = $certificates[0].Thumbprint
        # Resolve once so Tauri and the verification checks use the same SDK tool.
        $resolvedSignTool = & node -e "process.stdout.write(require('./scripts/windows-signing.cjs').signToolPath())"
        if ($LASTEXITCODE -ne 0) { throw 'Cannot locate SignTool.' }
        $env:TAURI_WINDOWS_SIGNTOOL_PATH = $resolvedSignTool
        Write-Host "Authenticode signing as $($certificates[0].Subject)"
    }
    npm.cmd ci --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Source checks failed.' }
    npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    if ($Official) {
        npm.cmd run release
        if ($LASTEXITCODE -ne 0) { throw 'Official build failed.' }
    } else {
        npm.cmd run dist:all
        if ($LASTEXITCODE -ne 0) { throw 'Beta build failed.' }
    }
    npm.cmd run test:browser
    if ($LASTEXITCODE -ne 0) { throw 'Browser tests failed.' }
    npm.cmd run notices
    if ($LASTEXITCODE -ne 0) { throw 'Notice generation failed.' }
    npm.cmd run package:installers
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
    if ($Msix) {
        npm.cmd run package:msix
        if ($LASTEXITCODE -ne 0) { throw 'MSIX packaging failed.' }
    }
} finally {
    Pop-Location
    $env:YAOC_AUTHENTICODE_THUMBPRINT = $oldThumbprint
    $env:TAURI_WINDOWS_SIGNTOOL_PATH = $oldSignTool
    $env:CARGO_TARGET_DIR = $oldTarget
    $env:YAOC_TEST_OFFICIAL = $oldOfficialTest
    # Return only generated source metadata, preserving any concurrent source edits.
    foreach ($file in $metadata) {
        $source = Join-Path $sourceRoot $file
        $local = Join-Path $BuildRoot $file
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHashes[$file]) {
            Write-Warning "Source changed during the build; review local metadata before syncing: $file"
        } elseif ((Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -ne $sourceHashes[$file]) {
            Copy-Item -LiteralPath $local -Destination $source -Force
        }
    }
}
Write-Host "Installers and portable executables: $(Join-Path $BuildRoot 'release')"
