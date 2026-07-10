# prepare-win-codesign.ps1
# Prepare electron-builder winCodeSign cache, skipping macOS symlinks.
# Solves: Windows non-admin users cannot create symlinks during 7z extraction.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/prepare-win-codesign.ps1

$ErrorActionPreference = "Stop"

$cacheRoot = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$version = "winCodeSign-2.6.0"
$targetDir = Join-Path $cacheRoot $version
$markerFile = Join-Path $targetDir ".win-only-extracted"

# Skip if already prepared
if (Test-Path $markerFile) {
    Write-Host "[winCodeSign] Cache already prepared. Skipping." -ForegroundColor Green
    exit 0
}

Write-Host "[winCodeSign] Preparing Windows-only cache..." -ForegroundColor Cyan

# Clean up old broken cache
if (Test-Path $cacheRoot) {
    Get-ChildItem $cacheRoot -Directory | Where-Object { $_.Name -ne $version } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem $cacheRoot -Filter "*.7z" | Remove-Item -Force -ErrorAction SilentlyContinue
}

# Download .7z
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
$tempZip = Join-Path $cacheRoot "$version.7z"
$url = "https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"

Write-Host "[winCodeSign] Downloading from $url ..."
try {
    Invoke-WebRequest -Uri $url -OutFile $tempZip -UseBasicParsing
}
catch {
    $url2 = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
    Write-Host "[winCodeSign] Retrying from GitHub: $url2"
    Invoke-WebRequest -Uri $url2 -OutFile $tempZip -UseBasicParsing
}
Write-Host "[winCodeSign] Downloaded $((Get-Item $tempZip).Length) bytes."

# Find 7za/7z executable.
# Preference order (most reliable first):
#   1. node_modules/7zip-bin (bundled, no symlink issues)
#   2. System 7-Zip install (present on GitHub windows-latest runners and many dev machines)
#   3. 7za/7z on PATH
$sevenZip = $null

# 1) node_modules/7zip-bin
$candidates = @(
    (Join-Path $PSScriptRoot "..\node_modules\7zip-bin\win\x64\7za.exe"),
    (Join-Path $PSScriptRoot "..\node_modules\7zip-bin\win\7za.exe"),
    (Join-Path $PSScriptRoot "..\node_modules\7zip-bin\win\ia32\7za.exe")
)
foreach ($c in $candidates) {
    if (Test-Path $c) { $sevenZip = $c; break }
}

# 2) System 7-Zip install
if (-not $sevenZip) {
    $progFiles = @(
        "C:\Program Files\7-Zip\7z.exe",
        "C:\Program Files (x86)\7-Zip\7z.exe"
    )
    foreach ($c in $progFiles) {
        if (Test-Path $c) { $sevenZip = $c; break }
    }
}

# 3) PATH: 7za or 7z
if (-not $sevenZip) {
    $cmd = Get-Command "7za.exe" -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command "7z.exe" -ErrorAction SilentlyContinue }
    if ($cmd) { $sevenZip = $cmd.Source }
}

if (-not $sevenZip) {
    Write-Error "[winCodeSign] Could not locate a 7z/7za executable. Install the '7zip-bin' npm package (npm i -D 7zip-bin) or install 7-Zip."
    exit 1
}
Write-Host "[winCodeSign] Using 7z: $sevenZip" -ForegroundColor Cyan

# Extract only Windows files, skip darwin/linux (they contain symlinks)
Write-Host "[winCodeSign] Extracting Windows-only files..."
& $sevenZip x $tempZip "-o$targetDir" "windows-10" "windows-6" "appxAssets" "openssl-ia32" "rcedit-x64.exe" "rcedit-ia32.exe" -y -bd 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Error "[winCodeSign] Extraction failed!"
    exit 1
}

# Write marker file
Set-Content -Path $markerFile -Value "Windows-only extraction. Created $(Get-Date -Format 'o')"

# Clean up .7z
Remove-Item $tempZip -Force -ErrorAction SilentlyContinue

Write-Host "[winCodeSign] Done! Cache prepared at $targetDir" -ForegroundColor Green
