// CMD health check: `node src/healthcheck.js` exits 0 if DATA_DIR/heartbeat is fresher than 120 s, else 1.
import path from 'node:path';
import { config } from './config.js';
import { heartbeatAgeSec } from './heartbeat.js';

const MAX_AGE_SEC = 120;
const file = path.join(config.dataDir, 'heartbeat');
const age = heartbeatAgeSec(file);
if (age < MAX_AGE_SEC) {
  console.log(`ok: heartbeat ${Math.round(age)} s old`);
  process.exit(0);
}
console.error(age === Infinity ? `unhealthy: ${file} missing` : `unhealthy: heartbeat ${Math.round(age)} s old (> ${MAX_AGE_SEC} s)`);
process.exit(1);
