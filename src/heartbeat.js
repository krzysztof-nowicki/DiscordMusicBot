// Liveness heartbeat for platforms without a port/restart policy (Northflank CMD health check):
// the bot rewrites DATA_DIR/heartbeat every 30 s while the Discord client is ready; src/healthcheck.js reads its age.
import fs from 'node:fs';
import path from 'node:path';

export const HEARTBEAT_EVERY_MS = 30_000;

/**
 * @param {string} file
 * @param {() => boolean} isReady  only beat while this is true (Discord gateway connected)
 * @returns {() => void} stop
 */
export function startHeartbeat(file, isReady, { everyMs = HEARTBEAT_EVERY_MS, log = () => {} } = {}) {
  let warned = false;
  const beat = () => {
    if (!isReady()) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, new Date().toISOString());
    } catch (e) {
      if (!warned) log(`heartbeat write failed: ${e.message}`);
      warned = true;
    }
  };
  beat();
  const h = setInterval(beat, everyMs);
  h.unref?.();
  return () => clearInterval(h);
}

/** Seconds since the heartbeat file was written (Infinity if missing). */
export function heartbeatAgeSec(file, now = Date.now()) {
  try {
    return (now - fs.statSync(file).mtimeMs) / 1000;
  } catch {
    return Infinity;
  }
}
