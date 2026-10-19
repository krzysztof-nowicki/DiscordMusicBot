// Optional HTTP health endpoint (PORT > 0) for container platforms: GET /health -> 200 JSON status.
import http from 'node:http';

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
