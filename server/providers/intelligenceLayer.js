// Read-only bridge to the local intelligence layer (a separate process on this
// machine). Only allowlisted files are forwarded, so this route can never be
// used to reach anything else.

const IL_API_BASE = (process.env.IL_API_BASE || 'http://127.0.0.1:8700').replace(/\/+$/, '');
const IL_TIMEOUT_MS = 5000;
const IL_FILES = Object.freeze({
  '/aircraft': 'aircraft.json',
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Vite plugin: GET /api/il/aircraft -> the intelligence layer's aircraft.json. */
export function intelligenceLayerProxy() {
  function install(middlewares) {
    middlewares.use('/api/il', async (req, res) => {
      const pathname = new URL(req.url || '', 'http://localhost').pathname;
      const file = IL_FILES[pathname];
      if (req.method !== 'GET' || !file) {
        sendJson(res, 404, { error: 'Unknown intelligence layer resource' });
        return;
      }
      try {
        const upstream = await fetch(`${IL_API_BASE}/${file}`, {
          signal: AbortSignal.timeout(IL_TIMEOUT_MS),
          cache: 'no-store',
        });
        if (!upstream.ok) {
          sendJson(res, 502, { error: `Intelligence layer answered HTTP ${upstream.status}` });
          return;
        }
        sendJson(res, 200, await upstream.text());
      } catch {
        sendJson(res, 503, {
          error: 'Intelligence layer not reachable on ' + IL_API_BASE + ' (is the il-api server running?)',
        });
      }
    });
  }

  return {
    name: 'intelligence-layer-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
