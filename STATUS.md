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

## Paused 2026-10-19 (session limit), resume here
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
