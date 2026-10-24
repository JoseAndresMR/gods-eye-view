// Read-only bridge to the local intelligence layer (a separate process on this
// machine). Only allowlisted file names are forwarded, so this route can never
// be used to reach anything else.

const IL_API_BASE = (process.env.IL_API_BASE || 'http://127.0.0.1:8700').replace(/\/+$/, '');
const IL_TIMEOUT_MS = 5000;
// A link distance in km as the intelligence layer names its files: "5", "20", "0.25".
const DISTANCE_KM = /^(?:[1-9]\d{0,3}(?:\.\d{1,3})?|0\.\d{0,2}[1-9])$/;
const KINDS = new Set(['aircraft', 'vessels', 'military', 'satellites', 'fires', 'gnss']);

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Map a request to the intelligence layer file it may read, or null. */
export function intelligenceLayerFile(url) {
  const { pathname, searchParams } = new URL(url || '', 'http://localhost');
  const [, kind, rest, extra] = pathname.split('/');
  if (!KINDS.has(kind) || extra !== undefined) return null;
  if (rest === 'index') return `${kind}-index.json`;
  if (rest === undefined) {
    const km = searchParams.get('km') || '';
    return DISTANCE_KM.test(km) ? `${kind}-${km}km.json` : null;
  }
  return null;
}

/**
 * Vite plugin, for kind = aircraft | vessels | military | satellites | fires | gnss:
 *   GET /api/il/<kind>/index     -> available link distances
 *   GET /api/il/<kind>?km=<km>   -> clusters at that distance
 */
export function intelligenceLayerProxy() {
  function install(middlewares) {
    middlewares.use('/api/il', async (req, res) => {
      const file = req.method === 'GET' ? intelligenceLayerFile(req.url) : null;
      if (!file) {
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
