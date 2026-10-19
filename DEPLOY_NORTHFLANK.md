# Deploying the music bot on Northflank (free "Sandbox" plan)

This guide takes you from the files on your PC to a bot that runs 24/7 on Northflank. It needs no public port; the
bot only connects *out* to Discord. Facts were checked on 2026-10-19. Northflank changes its UI and plans from time
to time, so if a screen looks different, the names below still point you to the right place.

> **Read first: the honest limitations**
> - Northflank asks for a **payment card** even on the free plan. You won't be charged as long as you stay within
>   the free limits.
> - The bot needs about **512 MB RAM**, i.e. plan **nf-compute-20 (0.2 vCPU / 512 MB)**. The smallest plan
>   (nf-compute-10, 256 MB) is too small. If the free project doesn't offer nf-compute-20 in the plan list, you'll
>   need a paid plan (about $5/month) or another host.
> - **YouTube often blocks datacenter IPs** ("Sign in to confirm you're not a bot"). The bot then falls back to
>   SoundCloud automatically. To make YouTube work reliably from the cloud, add **cookies** (step 6). Spotify links are
>   resolved to YouTube or SoundCloud, so they're affected the same way.
> - Outbound UDP (needed for Discord voice) isn't documented by Northflank. Northflank's own guide ran a music bot,
>   so it works in practice, but **test it in step 9**.
> - Files on the container disk (playlists, settings) are **lost on every redeploy** unless you attach a volume.
>   Free projects may not get volumes.

---

## 1. Put the code on GitHub (branch `main`)

Northflank builds straight from a GitHub repository.

**Option A: GitHub Desktop** (it's installed on your PC):
1. *File → Add local repository…* → `C:\Users\marom\PycharmProjects\DiscordMusicBot`. The repository already exists,
   on branch **main**.
2. Click **Publish repository**. Leave **Keep this code private** ticked. Keep the name `DiscordMusicBot`. Click **Publish**.
3. Later changes: write a summary, click **Commit to main**, then **Push origin**.

**Option B: command line**, after you create an empty private repo on github.com without a README:
```powershell
cd C:\Users\marom\PycharmProjects\DiscordMusicBot
git remote add origin https://github.com/<your-user>/DiscordMusicBot.git
git push -u origin main
```

`.env`, `data/`, `bin/`, `node_modules/` and `.node/` are git-ignored, so **your bot token never goes to GitHub**.

## 2. Create the Discord bot (skip it if you already did it for local use)
Follow **USAGE.md → "1. Create the bot"** and **"2. Invite it"**. Keep the **bot token** handy.

## 3. Create a Northflank account and link GitHub
1. Sign up at <https://app.northflank.com/signup>. Add a payment method when asked; that's required on all plans.
2. Go to **Team / Account settings → Integrations → Git** (<https://app.northflank.com/s/account/integrations/vcs>).
3. Click **Link GitHub**, choose your account, and grant access to the **DiscordMusicBot** repository (you can pick
   "Only select repositories"). Click **Authorise**.

## 4. Create a project
1. Click **Create project**.
2. Name it `music-bot` and pick a **region** close to your Discord voice region, e.g. **Europe – West (Frankfurt)**.
3. Click **Create project**.

## 5. Create the service (build + run from GitHub)
1. Inside the project: **Create new → Service → Combined service**. "Combined" means it builds and deploys.
2. **Name:** `music-bot`.
3. **Repository:** `DiscordMusicBot`, **branch:** `main`.
4. **Build options:** choose **Dockerfile**, with **Dockerfile location** `/Dockerfile` and **build context** `/`.
5. **Environment variables:** skip for now (step 6).
6. **Networking / Ports:** **remove** any port Northflank detected. The bot needs **no ports**.
7. **Resources:** compute plan **nf-compute-20** (0.2 vCPU / 512 MB), **1 instance**.
8. Click **Create service**. The first build takes a few minutes; watch it under **Builds**. It will start and then
   complain that `DISCORD_TOKEN` is missing. That's expected; step 6 fixes it.

## 6. Add the secrets (token, optional Spotify keys and YouTube cookies)
1. In the project: **Secrets → Create secret group**. Name it `music-bot-secrets`, with **Type: Secret** and **Scope: Runtime**.
2. Add the variables:

| Key | Value | Needed? |
|---|---|---|
| `DISCORD_TOKEN` | your bot token | **required** |
| `GUILD_ID` | your server ID (right-click the server → *Copy Server ID*; turn on Developer Mode first) | recommended (commands appear instantly) |
| `LANG_BOT` | `pl` or `en` | optional (default `pl`) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | from <https://developer.spotify.com/dashboard> | optional (needed for big Spotify playlists) |
| `DJ_ROLE` | name of a role allowed to stop/skip others/change volume | optional |
| `YTDLP_COOKIES_B64` | your YouTube cookies.txt, **base64-encoded** (see below) | optional, strongly recommended in the cloud |

3. **Restrict the secret group** to the `music-bot` service if you like. Then **Save** and **restart** the service
   (service page → **⋯ → Restart**).

**YouTube cookies (makes YouTube work from the cloud):**
1. Use a **throwaway Google account**, not your main one. YouTube may flag accounts used by bots.
2. In Chrome, install **"Get cookies.txt LOCALLY"**. Do **not** install the similarly named "Get cookies.txt"; it was malware.
3. Open a **private/incognito window**, allow the extension there, log in to YouTube, then go to
   `https://www.youtube.com/robots.txt`. Export the cookies for youtube.com as `cookies.txt`, then **close the private
   window**. Closing it keeps the session from being rotated.
4. Base64-encode the file in PowerShell and copy the result:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\cookies.txt")) | Set-Clipboard
   ```
5. Paste it as the value of `YTDLP_COOKIES_B64` in the secret group, then restart the service.
6. Cookies expire after a while (weeks or months). If YouTube starts failing again, repeat these steps.

## 7. Health check (auto-restart if the bot hangs)
Northflank restarts a container that *exits*, but not one that *hangs*. Add a command check:
1. Service → **Health checks → Add health check**.
2. Set **Type: Liveness** and **Protocol: CMD**, with command `node src/healthcheck.js`.
3. Set **Initial delay** 60 s, **interval** 60 s and **failure threshold** 3.

The bot touches a heartbeat file every 30 s while it's connected to Discord, and the check fails if the file goes stale.

## 8. Check the logs
Service → **Logs**. A healthy start looks like:
```
[tools] yt-dlp 2026.xx.xx ready (node JS runtime)
[bot] Logged in as MusicBot#1234 — 1 server(s), commands registered
```
Every 10 min you'll see a resource line (RSS MB, active players). It should stay well under 512 MB.

## 9. First test in Discord (it also proves UDP voice works)
1. Join a voice channel on your server.
2. Type `/play` and choose the **query** option, e.g. `never gonna give you up`.
3. You should hear music within a few seconds and see a **Now playing** card with buttons.
4. If the bot joins but you hear nothing, check the logs. Errors such as `UDP`, `IP discovery` or `VoiceConnection
   timed out` mean outbound UDP is blocked on this host. In that case run the bot on your PC (README.md) or on
   another host.

## 10. Updating
- **Code changes:** commit and push to `main`. Northflank **rebuilds and redeploys automatically** (CI/CD is on by
  default; the toggles are in the service header).
- **yt-dlp:** the bot updates yt-dlp itself at start-up (at most once a day). If YouTube breaks, restart the
  service; that downloads the newest yt-dlp.

## Saving resources (already built in)
The bot is tuned for a 0.2-vCPU box, and every limit below is an environment variable you can override.

**When it leaves the voice channel:**
- It pauses as soon as it is **alone** in the channel and leaves after `ALONE_LEAVE_MIN` (3).
- It leaves after `IDLE_LEAVE_MIN` (5) minutes **without music**.
- After `PAUSE_KILL_SEC` (60) seconds of **pause** it stops its audio processes and remembers the position. It
  leaves after `PAUSE_LEAVE_MIN` (10).

**Other limits:**
- At most `MAX_ACTIVE_PLAYERS` (3) servers play at the same time.
- Only one yt-dlp lookup runs at a time (`YTDLP_CONCURRENCY` = 1).
- Ogg/Opus is encoded by ffmpeg once, with no re-encoding in Node (`AUDIO_MODE=opus`).
- The *Now playing* card refreshes only every `NP_UPDATE_SEC` (30) seconds.
- Autoplay is off by default; queue/playlist caps are `MAX_QUEUE` (500) and `MAX_PLAYLIST` (200).

## Troubleshooting
| Symptom | Fix |
|---|---|
| Build fails at `npm ci` | Make sure `package-lock.json` is committed, then re-run the build. |
| Logs: `DISCORD_TOKEN missing` | Add it to the secret group and restart (step 6). |
| Slash commands don't appear | Set `GUILD_ID` (instant), or wait up to an hour for global commands. Re-invite the bot with the `applications.commands` scope (USAGE.md). |
| `Sign in to confirm you're not a bot` | Add `YTDLP_COOKIES_B64` (step 6). Meanwhile tracks fall back to SoundCloud; the card shows "(z SoundCloud)". |
| Audio stutters | The box is at its CPU limit. Play in one server at a time, or upgrade to nf-compute-50. |
| Container restarts with `OOMKilled` | You're on 256 MB; switch to nf-compute-20 (512 MB). |
| Close code `4017` | Old voice library without DAVE. Pull the latest code; the repo pins @discordjs/voice 0.19.2 with DAVE. |
| Playlists vanished after redeploy | The container disk is ephemeral. Attach a volume at `/app/data` if your plan allows it, or re-save them. |
