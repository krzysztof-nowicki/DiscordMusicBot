# DiscordMusicBot: small Linux image (Northflank free plan nf-compute-20: 0.2 vCPU / 512 MB, or any Docker host).
#   docker build -t discord-music-bot .                       (latest yt-dlp)
#   docker build --build-arg YTDLP_VERSION=2026.10.01 -t discord-music-bot .
#   docker run --rm -e DISCORD_TOKEN=... -e GUILD_ID=... discord-music-bot
FROM node:24-bookworm-slim

# yt-dlp release tag ("latest" or e.g. 2026.10.01). tools.js still self-updates it at runtime into BIN_DIR.
ARG YTDLP_VERSION=latest

# ffmpeg (decode + Opus encode) and CA certs for HTTPS; curl only for the download below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp standalone Linux build into /app/bin. No deno: yt-dlp uses node as its JS runtime.
RUN mkdir -p /app/bin /app/data /app/music /app/cache \
 && if [ "$YTDLP_VERSION" = "latest" ]; then \
      url=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux; \
    else \
      url=https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp_linux; \
    fi \
 && curl -fsSL -o /app/bin/yt-dlp "$url" \
 && chmod 0755 /app/bin/yt-dlp \
 && /app/bin/yt-dlp --version \
 && apt-get purge -y curl && apt-get autoremove -y

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
# Optional local library baked into the image (put files in music/ before building).
COPY music ./music

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=192 \
    AUDIO_MODE=opus \
    BIN_DIR=/app/bin \
    YTDLP_PATH=/app/bin/yt-dlp \
    DATA_DIR=/app/data \
    MUSIC_DIR=/app/music \
    XDG_CACHE_HOME=/app/cache

# Runtime user must be able to self-update yt-dlp (bin), write settings/heartbeat (data) and yt-dlp's cache.
RUN chown -R node:node /app/bin /app/data /app/cache
USER node

# Liveness: the bot rewrites DATA_DIR/heartbeat every 30 s while connected to Discord.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "src/healthcheck.js"]

# SIGTERM is handled by the bot: leaves voice, kills ffmpeg/yt-dlp.
CMD ["node", "src/index.js"]
