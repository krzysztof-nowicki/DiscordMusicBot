// Optional HTTP health endpoint (PORT > 0) for container platforms: GET /health -> 200 JSON status.
import http from 'node:http';

/** `[res] rss=123MB heap=45MB players=1/3 uptime=2h05m` (logged every 10 min). */
export function resourceLine(players, maxPlayers, mem = process.memoryUsage(), uptimeSec = process.uptime()) {
  const mb = (n) => Math.round(n / 1048576);
  const h = Math.floor(uptimeSec / 3600);
  const m = String(Math.floor((uptimeSec % 3600) / 60)).padStart(2, '0');
  return `[res] rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}MB players=${players}/${maxPlayers || '∞'} uptime=${h}h${m}m`;
}

/**
 * @param {number} port
 * @param {() => object} status  extra fields merged into the JSON
 * @returns {Promise<http.Server>}
 */
export function startHealthServer(port, status) {
  const started = Date.now();
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (url !== '/health' && url !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    let body;
    try {
      body = JSON.stringify({ status: 'ok', uptimeSec: Math.round((Date.now() - started) / 1000), ...status() });
    } catch (e) {
      body = JSON.stringify({ status: 'error', error: e.message });
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
