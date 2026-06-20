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

# Find 7za.exe
$sevenZip = Join-Path $PSScriptRoot "..\node_modules\7zip-bin\win\x64\7za.exe"
if (-not (Test-Path $sevenZip)) {
    $sevenZip = "7za"
}

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
