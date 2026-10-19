// Liveness heartbeat for platforms without a port/restart policy (Northflank CMD health check):
// the bot rewrites DATA_DIR/heartbeat every 30 s while the Discord client is ready; src/healthcheck.js reads its age.
// If DATA_DIR is not writable (e.g. a root-owned volume), the heartbeat goes to the temp dir instead; the check
// looks at both and takes the freshest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HEARTBEAT_EVERY_MS = 30_000;

/** [primary, fallback] heartbeat paths. */
export function heartbeatFiles(dataDir) {
  return [path.join(dataDir, 'heartbeat'), path.join(os.tmpdir(), 'discord-music-bot-heartbeat')];
}

/**
 * @param {string[]} files  candidates in order of preference (see heartbeatFiles)
 * @param {() => boolean} isReady  only beat while this is true (Discord gateway connected)
 * @returns {() => void} stop
 */
export function startHeartbeat(files, isReady, { everyMs = HEARTBEAT_EVERY_MS, log = () => {} } = {}) {
  let idx = 0;
  let warned = false;
  const beat = () => {
    if (!isReady()) return;
    while (idx < files.length) {
      try {
        fs.mkdirSync(path.dirname(files[idx]), { recursive: true });
        fs.writeFileSync(files[idx], new Date().toISOString());
        return;
      } catch (e) {
        log(`heartbeat: cannot write ${files[idx]} (${e.code || e.message})${idx + 1 < files.length ? `, using ${files[idx + 1]}` : ''}`);
        idx++;
      }
    }
    if (!warned) log('heartbeat: no writable location; the health check will report unhealthy');
    warned = true;
  };
  beat();
  const h = setInterval(beat, everyMs);
  h.unref?.();
  return () => clearInterval(h);
}

/** Seconds since the freshest of the heartbeat files was written (Infinity if none exists). */
export function heartbeatAgeSec(files, now = Date.now()) {
  let best = Infinity;
  for (const f of [files].flat()) {
    try {
      best = Math.min(best, (now - fs.statSync(f).mtimeMs) / 1000);
    } catch {
      /* missing */
    }
  }
  return best;
}
