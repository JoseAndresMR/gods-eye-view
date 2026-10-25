// Read-only bridge to the local intelligence layer (a separate process on this
// machine), plus saving its areas of interest. Only allowlisted resources are
// forwarded, so this route can never be used to reach anything else.

const IL_API_BASE = (process.env.IL_API_BASE || 'http://127.0.0.1:8700').replace(/\/+$/, '');
const IL_TIMEOUT_MS = 5000;
const MAX_AREAS_BODY = 64 * 1024;
// A link distance in km as the intelligence layer names it: "5", "20", "0.25".
const DISTANCE_KM = /^(?:[1-9]\d{0,3}(?:\.\d{1,3})?|0\.\d{0,2}[1-9])$/;
const KINDS = new Set([
  'aircraft', 'vessels', 'military', 'satellites', 'fires', 'gnss',
  'military-areas', 'datacenters', 'dams', 'landings', 'cameras',
]);
/** Cluster feeds whose satellite observation the intelligence layer computes. */
const OBSERVED_KINDS = new Set(['military-areas', 'datacenters', 'dams', 'landings']);
const MAX_OBSERVED_TARGETS = 8;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** "W,S,E,N" in degrees, normalized, or null when absent or invalid. */
function parseBbox(raw) {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [w, s, e, n] = parts;
  if (Math.abs(w) > 180 || Math.abs(e) > 180 || s < -90 || n > 90 || s >= n) return null;
  return parts.map((v) => Number(v.toFixed(4))).join(',');
}

/**
 * Map a request to the intelligence layer API path it may reach, or null.
 *   GET /<kind>/index                  → /api/<kind>/index
 *   GET /<kind>?km=<km>[&bbox=W,S,E,N] → /api/<kind>?km=…[&bbox=…]
 *   GET /observability?targets=<kind>:<km>,…[&bbox=W,S,E,N] → /api/observability?…
 *   GET|PUT /areas                     → /api/areas
 */
export function intelligenceLayerPath(method, url) {
  const { pathname, searchParams } = new URL(url || '', 'http://localhost');
  const [, first, rest, extra] = pathname.split('/');
  if (first === 'areas' && rest === undefined)
    return method === 'GET' || method === 'PUT' ? '/api/areas' : null;
  if (first === 'observability' && rest === undefined)
    return method === 'GET' ? observabilityPath(searchParams) : null;
  if (method !== 'GET' || !KINDS.has(first) || extra !== undefined) return null;
  if (rest === 'index') return `/api/${first}/index`;
  if (rest !== undefined) return null;
  const km = searchParams.get('km') || '';
  if (!DISTANCE_KM.test(km)) return null;
  const rawBbox = searchParams.get('bbox');
  const bbox = parseBbox(rawBbox);
  if (rawBbox && !bbox) return null;
  return `/api/${first}?km=${km}${bbox ? `&bbox=${bbox}` : ''}`;
}

function observabilityPath(searchParams) {
  const targets = (searchParams.get('targets') || '').split(',').filter(Boolean);
  if (targets.length > MAX_OBSERVED_TARGETS) return null;
  for (const target of targets) {
    const [kind, km, more] = target.split(':');
    if (more !== undefined || !OBSERVED_KINDS.has(kind) || !DISTANCE_KM.test(km || '')) return null;
  }
  const rawBbox = searchParams.get('bbox');
  const bbox = parseBbox(rawBbox);
  if (rawBbox && !bbox) return null;
  return `/api/observability?targets=${targets.join(',')}${bbox ? `&bbox=${bbox}` : ''}`;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Vite plugin: /api/il/* → the intelligence layer's localhost API
 * (cluster feeds, their satellite observation, areas of interest).
 */
export function intelligenceLayerProxy() {
  function install(middlewares) {
    middlewares.use('/api/il', async (req, res) => {
      const path = intelligenceLayerPath(req.method, req.url);
      if (!path) {
        sendJson(res, 404, { error: 'Unknown intelligence layer resource' });
        return;
      }
      try {
        const init = { signal: AbortSignal.timeout(IL_TIMEOUT_MS), cache: 'no-store' };
        if (req.method === 'PUT') {
          init.method = 'PUT';
          init.headers = { 'Content-Type': 'application/json' };
          init.body = await readBody(req, MAX_AREAS_BODY);
        }
        const upstream = await fetch(`${IL_API_BASE}${path}`, init);
        const text = await upstream.text();
        // The IL answers JSON errors (a refused area, a feed not written yet).
        sendJson(res, upstream.ok ? 200 : upstream.status === 400 ? 400 : 502, text);
      } catch (error) {
        if (error?.status === 413) {
          sendJson(res, 413, { error: 'Areas must be under 64 KB' });
          return;
        }
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
