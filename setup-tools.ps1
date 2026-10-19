# Tools part of the setup (owner: sources). Dot-source it and call Install-MusicBotTools, or run it directly:
#   . .\setup-tools.ps1; Install-MusicBotTools            # yt-dlp (+ ffmpeg check)
#   .\setup-tools.ps1 -WithDeno                           # also Deno (only needed with YTDLP_JS_RUNTIME=deno)
# yt-dlp needs a JavaScript runtime for YouTube; the bot passes its own node.exe (--js-runtimes node:...), so Deno
# is optional. The bot itself also downloads yt-dlp on first start and runs `yt-dlp -U` at most once a day.
param([switch]$WithDeno, [string]$BinDir)

function Install-MusicBotTools {
    param([string]$BinDir, [switch]$WithDeno)
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $root = $PSScriptRoot
    if (-not $BinDir) { $BinDir = if ($env:BIN_DIR) { Join-Path $root $env:BIN_DIR } else { Join-Path $root 'bin' } }
    New-Item -ItemType Directory -Force $BinDir | Out-Null
    $ok = $true

    # yt-dlp
    $ytdlp = if ($env:YTDLP_PATH) { $env:YTDLP_PATH } else { Join-Path $BinDir 'yt-dlp.exe' }
    if (-not (Test-Path $ytdlp)) {
        Write-Host 'Downloading yt-dlp.exe ...'
        Invoke-WebRequest -UseBasicParsing 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile "$ytdlp.part"
        Move-Item -Force "$ytdlp.part" $ytdlp
    } else {
        Write-Host 'Updating yt-dlp ...'
        & $ytdlp -U | Select-Object -Last 1 | Write-Host
    }
    $v = & $ytdlp --version
    Write-Host "  yt-dlp $v  ($ytdlp)" -ForegroundColor Green

    # Deno (optional)
    if ($WithDeno -or $env:YTDLP_JS_RUNTIME -eq 'deno') {
        $deno = Join-Path $BinDir 'deno.exe'
        if (-not (Test-Path $deno)) {
            Write-Host 'Downloading Deno ...'
            $tmp = Join-Path ([IO.Path]::GetTempPath()) ("deno-" + [guid]::NewGuid())
            New-Item -ItemType Directory $tmp | Out-Null
            try {
                Invoke-WebRequest -UseBasicParsing 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' -OutFile (Join-Path $tmp 'deno.zip')
                Expand-Archive (Join-Path $tmp 'deno.zip') -DestinationPath $tmp
                Copy-Item (Join-Path $tmp 'deno.exe') $deno
            } finally { Remove-Item -Recurse -Force $tmp }
        }
        Write-Host "  $(& $deno --version | Select-Object -First 1)  ($deno)" -ForegroundColor Green
    }

    # ffmpeg (not downloaded: install it once system-wide)
    $ffmpeg = $null
    foreach ($c in @($env:FFMPEG_PATH, 'ffmpeg', 'C:\ffmpeg\bin\ffmpeg.exe', (Join-Path $BinDir 'ffmpeg.exe'), (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'))) {
        if (-not $c) { continue }
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { $ffmpeg = $cmd.Source; break }
    }
    if ($ffmpeg) {
        $fv = (& $ffmpeg -hide_banner -version | Select-Object -First 1)
        Write-Host "  $fv  ($ffmpeg)" -ForegroundColor Green
        if (-not ((& $ffmpeg -hide_banner -encoders 2>$null) -match 'libopus')) {
            Write-Host '  warning: this ffmpeg has no libopus encoder (AUDIO_MODE=opus will not work; pcm is fine)' -ForegroundColor Yellow
        }
    } else {
        $ok = $false
        Write-Host '  ffmpeg not found. Install it with:  winget install --id Gyan.FFmpeg -e' -ForegroundColor Red
        Write-Host '  (then open a new terminal, or set FFMPEG_PATH in .env)' -ForegroundColor Red
    }
    return $ok
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not (Install-MusicBotTools -BinDir $BinDir -WithDeno:$WithDeno)) { exit 1 }
}
