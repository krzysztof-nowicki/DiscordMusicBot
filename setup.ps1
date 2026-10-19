# DiscordMusicBot - one-time setup (Windows PowerShell 5.1+).
#   .\setup.ps1              check Node, offer a portable Node if too old, npm install, tools, create .env
#   .\setup.ps1 -Yes         same, without asking
#   .\setup.ps1 -LatestLts   use the newest Node LTS from nodejs.org instead of the pinned version
param(
    [switch]$Yes,
    [switch]$LatestLts
)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# Pinned portable Node LTS (from https://nodejs.org/dist/index.json, Oct 2026).
$NodeVersion = 'v24.22.0'
$MinNode = [version]'22.12.0'
$PortableRoot = Join-Path $PSScriptRoot '.node'

function Get-NodeVersion([string]$exe) {
    try {
        $v = & $exe --version 2>$null
        if ($v -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    } catch { }
    return $null
}

if ($LatestLts) {
    Write-Host 'Looking up the latest Node LTS...'
    $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
    $NodeVersion = ($index | Where-Object { $_.lts } | Select-Object -First 1).version
    Write-Host "Latest LTS: $NodeVersion"
}

$nodeExe = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys) {
    $v = Get-NodeVersion $sys.Source
    if ($v -and $v -ge $MinNode) {
        Write-Host "System Node $v is fine (>= $MinNode)."
        $nodeExe = $sys.Source
    } else {
        Write-Host "System Node $v is too old: @discordjs/voice 0.19 (DAVE) needs >= $MinNode."
    }
} else {
    Write-Host 'Node.js not found on PATH.'
}

if (-not $nodeExe) {
    $portableDir = Join-Path $PortableRoot "node-$NodeVersion-win-x64"
    $portableExe = Join-Path $portableDir 'node.exe'
    if (-not (Test-Path $portableExe)) {
        $existing = Get-ChildItem -Path $PortableRoot -Filter 'node-v*-win-x64' -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Sort-Object Name -Descending | Select-Object -First 1
        if ($existing) { $portableDir = $existing.FullName; $portableExe = Join-Path $portableDir 'node.exe' }
    }
    if (-not (Test-Path $portableExe)) {
        Write-Host ''
        Write-Host 'Option A: install Node LTS system-wide:  winget install OpenJS.NodeJS.LTS   (then re-run this script)'
        Write-Host "Option B: download a portable Node $NodeVersion into .node\ (no admin, nothing else changes)"
        $ok = $Yes
        if (-not $ok) { $ok = (Read-Host 'Download portable Node now? [Y/n]') -notmatch '^[nN]' }
        if (-not $ok) { Write-Host 'Aborted.'; exit 1 }

        $zipName = "node-$NodeVersion-win-x64.zip"
        $base = "https://nodejs.org/dist/$NodeVersion"
        $dl = Join-Path $PortableRoot '_download'
        New-Item -ItemType Directory -Force -Path $dl | Out-Null
        $zip = Join-Path $dl $zipName
        Write-Host "Downloading $base/$zipName ..."
        $ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster on PS 5.1
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$zipName" -OutFile $zip
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
        $expected = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1) -replace '\s+.*$', ''
        $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
        if (-not $expected -or $actual -ne $expected.ToLower()) {
            Remove-Item -Recurse -Force $dl
            throw "SHA256 mismatch for $zipName (expected $expected, got $actual)"
        }
        Write-Host 'Checksum OK, extracting...'
        Expand-Archive -Path $zip -DestinationPath $PortableRoot -Force
        Remove-Item -Recurse -Force $dl
        $portableDir = Join-Path $PortableRoot "node-$NodeVersion-win-x64"
        $portableExe = Join-Path $portableDir 'node.exe'
    }
    $nodeExe = $portableExe
    Write-Host "Using portable Node $(& $nodeExe --version) from $portableDir"
}

$nodeDir = Split-Path -Parent $nodeExe
$env:Path = "$nodeDir;$env:Path"
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm' }

Write-Host 'Installing packages (npm install)...'
$ErrorActionPreference = 'Continue'   # npm writes warnings to stderr; judge success by exit code only
& $npm install --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm install failed. If the error mentions @discordjs/opus / node-gyp, the pure-JS opusscript fallback is used automatically; retry with: npm install --omit=optional opusscript' -ForegroundColor Yellow
    exit $LASTEXITCODE
}
$ErrorActionPreference = 'Stop'

& $nodeExe -e "console.log(require('@discordjs/voice').generateDependencyReport())"

# yt-dlp / deno / ffmpeg (written by the sources agent; optional here - the bot also downloads yt-dlp at startup).
$tools = Join-Path $PSScriptRoot 'setup-tools.ps1'
if (Test-Path $tools) {
    Write-Host 'Setting up yt-dlp / deno / ffmpeg...'
    & $tools
} else {
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not (Test-Path 'C:\ffmpeg\bin\ffmpeg.exe')) {
        Write-Host 'ffmpeg not found. Install it: winget install Gyan.FFmpeg   (or set FFMPEG_PATH in .env)' -ForegroundColor Yellow
    }
}

if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from .env.example - open it and paste your DISCORD_TOKEN.' -ForegroundColor Yellow
}
Write-Host 'Setup done. Start with: .\start.ps1' -ForegroundColor Green
