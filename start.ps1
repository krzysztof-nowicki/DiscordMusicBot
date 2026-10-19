# Start the music bot. Uses the portable Node in .node\ if present, else the system Node.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$nodeExe = $null
$portable = Get-ChildItem -Path (Join-Path $PSScriptRoot '.node') -Filter 'node-v*-win-x64' -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Sort-Object Name -Descending | Select-Object -First 1
if ($portable) {
    $nodeExe = Join-Path $portable.FullName 'node.exe'
    $env:Path = "$($portable.FullName);$env:Path"
} else {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Host 'Node.js not found. Run .\setup.ps1 first.' -ForegroundColor Red; exit 1 }
    $nodeExe = $cmd.Source
}

$v = & $nodeExe --version
if ($v -match '^v(\d+\.\d+\.\d+)' -and [version]$Matches[1] -lt [version]'22.12.0') {
    Write-Host "Node $v is too old (need >= 22.12). Run .\setup.ps1" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'node_modules')) { Write-Host 'node_modules missing. Run .\setup.ps1 first.' -ForegroundColor Red; exit 1 }
if (-not (Test-Path '.env')) { Write-Host '.env missing. Copy .env.example to .env and fill in DISCORD_TOKEN.' -ForegroundColor Red; exit 1 }
# ffmpeg is often installed to C:\ffmpeg\bin without being on PATH.
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Test-Path 'C:\ffmpeg\bin\ffmpeg.exe')) {
    $env:Path = "C:\ffmpeg\bin;$env:Path"
}

Write-Host "Starting the music bot with Node $v ($nodeExe). Stop with Ctrl+C."
$ErrorActionPreference = 'Continue'   # node's stderr must not abort the script
& $nodeExe src/index.js @args
exit $LASTEXITCODE
