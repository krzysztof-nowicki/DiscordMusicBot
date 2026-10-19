// CMD health check: `node src/healthcheck.js` exits 0 if the heartbeat (DATA_DIR/heartbeat, or the temp-dir
// fallback) is fresher than 120 s, else 1.
import { config } from './config.js';
import { heartbeatAgeSec, heartbeatFiles } from './heartbeat.js';

const MAX_AGE_SEC = 120;
const files = heartbeatFiles(config.dataDir);
const age = heartbeatAgeSec(files);
if (age < MAX_AGE_SEC) {
  console.log(`ok: heartbeat ${Math.round(age)} s old`);
  process.exit(0);
}
console.error(age === Infinity ? `unhealthy: no heartbeat (${files.join(', ')})` : `unhealthy: heartbeat ${Math.round(age)} s old (> ${MAX_AGE_SEC} s)`);
process.exit(1);
