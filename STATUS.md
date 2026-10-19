# DiscordMusicBot: status / handoff

To resume after a usage-limit reset, open Claude Code here and say: "Read STATUS.md and continue."
The contract is in DESIGN.md. The agent logs are `notes/sources.md` and `notes/player.md`.

_Requested 2026-10-19: a music bot that plays from YouTube, Spotify, any other source, and local files, in its own project folder._

## Done
- [x] Scaffold:
  - DESIGN.md, `src/config.js`, `package.json` (discord.js 14.27, @discordjs/voice 0.19.2 + davey for DAVE), `.env.example`, `.gitignore`;
  - portable Node 24.22 copied into `.node/`; `npm install` done;
  - ffmpeg 7.1 found at `C:\ffmpeg\bin`.

## In progress
- [ ] S, sources (`src/sources/**`, `src/tools.js`): yt-dlp (+ Deno if YouTube needs it), Spotify via embed / Web API → YouTube match,
  SoundCloud, Bandcamp, radio, direct URLs, local library with `music-metadata`, and seekable streams with no orphan processes.
- [ ] P, player and Discord (`src/index.js`, `src/player`, `src/commands`, `src/ui`): queue, loop, shuffle, seek, volume, auto-leave,
  autoplay, now-playing embed with buttons, playlists, DJ role, PL/EN messages, README, setup/start scripts.

## Resumed 2026-10-19 (session 2), with a new requirement: run on the Northflank free plan, plus full docs
- Contract: DESIGN.md section "Cloud: Northflank free plan". Config gained AUDIO_MODE, YTDLP_COOKIES_B64, YT_FALLBACK, PORT, DATA_DIR and BIN_DIR.
- Agents: S and P resumed. A research agent is checking Northflank's free-tier limits, the UI steps, UDP, and YouTube from datacenter IPs.
- The lead writes the docs once the research is in: README.md (local), DEPLOY_NORTHFLANK.md (step by step) and USAGE.md (Discord: invite + every command with URL/file/choice examples).

### Progress (session 2)
- [x] **P**, player: 40 tests. Every resource limit is in place (alone/idle/pause-kill/pause-leave, max players, rate limit,
  rare now-playing edits). Dockerfile + healthcheck done.
- [x] **S**, sources: 49 offline + 16 live tests, verified on Windows and WSL Ubuntu.
  - yt-dlp uses node as its JS runtime (no Deno in the image).
  - Spotify playlists are capped at 100 songs (a Spotify change from Feb 2026).
  - SoundCloud fallback when YouTube runs a bot check.
- [x] Docs: README.md, USAGE.md (every command, checked against the code), DEPLOY_NORTHFLANK.md and .env.example.
- [x] The Docker image builds (56 s, 1.19 GB). At 0.2 CPU / 512 MB the RSS is 50–90 MB.
- [x] Fixed the zero-byte stream bug. The cause was a pause+unshift that blocked `on('data')`; it now returns a
  PassThrough. Regression tests added.
- [x] Fresh-context review: 10 bugs plus 8 doc mismatches, all fixed with regression tests. The bugs included:
  - arbitrary local file read via an absolute path or UNC;
  - an endless m3u loop;
  - abort on skip;
  - volume or pause while a stream is opening;
  - player slot leak;
  - zombies (tini added);
  - EACCES data-dir fallback;
  - DAVE recreate;
  - the SoundCloud note.
- [x] Final verification: `npm test` 64/64, `npm run test:live` 17/17, `npm run test:docker` 29/29.
  - Container at `--cpus=0.2 --memory=512m`: first YouTube audio after 5.7–11 s, radio/local 0.3 s.
  - Peak memory about 309 MiB, node RSS about 90 MB.
- [ ] User: test on real Discord (needs the token), then deploy to Northflank (DEPLOY_NORTHFLANK.md). Not testable here:
  real Discord voice and Northflank outbound UDP.

## Paused 2026-10-19 (session limit), earlier resume notes
The two implementer agents (S = sources, P = player) were stopped mid-work. Their code was committed as a WIP on `main`.
**Only `main`, never other branches** (the user's rule).

To continue tomorrow, open Claude Code in `C:\Users\marom\PycharmProjects\DiscordMusicBot` and say:
"Read STATUS.md and DESIGN.md and continue the music bot."

Then do the following:
1. Check what exists: `src/sources/*` (detect, youtube, ytdlp, spotify, match, local), `src/player/*`, `src/commands/*`,
   `src/ui/*`, and `tests/`. Check whether `notes/sources.md` and `notes/player.md` exist.
2. Run the tests with the portable Node:
   `$env:PATH="$PWD\.node\node-v24.22.0-win-x64;$env:PATH"; npm test` (offline), then `npm run test:live` (needs network + yt-dlp in bin/).
3. Finish what's missing against DESIGN.md:
   - S: live verification of YouTube in 2026 (does yt-dlp need Deno? `--js-runtimes`?), Spotify embed + Web API,
     SoundCloud/Bandcamp/radio/direct URL, local library, seek, and orphan-process cleanup; `setup-tools.ps1`.
   - P: `src/index.js`, the now-playing UI, `README.md` (step-by-step setup instructions; this is what the user asked for),
     `setup.ps1`, `start.ps1`, tests.
4. Run a verifier review, fix the problems, and commit on main.

## Next
- [ ] Integration review (verifier) and fixes.
- [ ] `git init` and commit.
- [ ] User: paste the bot token into `.env`, invite the bot, run `start.ps1`.
