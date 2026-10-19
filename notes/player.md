# Agent P (player & Discord) log

## Done
- src/ui/i18n.js (pl/en strings + command descriptions with pl localizations), src/store.js (settings.json, playlists.json; atomic writes; setDataDir for tests)
- src/player/voice.js (joinVoiceChannel daveEncryption:true, reconnect/rejoin, 4014/4017 handling, DAVE-failure rejoin)
- src/player/GuildPlayer.js (queue/history/loop/skip n/seek/replay/volume/prefetch/autoplay/auto-leave/failure counting)
- src/player/manager.js (one player per guild, connect/move, notices, voice-state → checkAlone)
- src/commands/{util,play,local,control,queue,playlist,index}.js, src/ui/nowPlaying.js, src/index.js
- test/player.test.js (fakes), test/player.e2e.test.js (real ffmpeg + real AudioPlayer): green

## Next (session 2, Northflank requirement)
- createStream {type:'raw'|'ogg/opus'}; OggOpus has no inlineVolume → debounced re-create at position on /volume
- /play + /playnext `file` attachment option; fallbackFrom:'youtube' note; health server (PORT); Dockerfile/.dockerignore/music/.gitkeep
- setup.ps1/start.ps1; test/commands.test.js
- README/DEPLOY/USAGE docs: written by the lead, not P

## Design notes / gotchas
- Idle handling: every transition (start/skip/stop/seek/destroy) calls _halt(): token++, `resource = null` BEFORE
  player.stop(), then kill(). The Idle listener only advances when `oldState.resource === this.resource`, so the Idle fired
  by a manual stop is ignored. createStream results arriving after token changed are killed and dropped.
- Failure = AudioPlayer error for that resource, createStream throw, or < 1 s played from 0 (not live, duration > 2 s).
  3 in a row → stop + message. Failed tracks are not re-queued by loop modes.
- Prefetch: timer at (remaining - 20 s) for queue[0]; rescheduled on every queue mutation; WeakSet avoids repeats.
- Auto-leave: idle timer armed on queue end / stop / pause, cleared on start/resume; alone timer via checkAlone()
  driven by VoiceStateUpdate. Timers are unref'd.
- Autocomplete answers within 2.5 s: youtube+local searches race a timer; late results still fill the cache.
  Choice values > 100 chars (and local tracks) become `ac:<n>` tokens mapping to the Track.
- AudioPlayer default noSubscriber = Pause (no audio lost during reconnects); tests pass Play.
- npm test glob is test/*.test.js, so test/helpers/ is not run as tests.
