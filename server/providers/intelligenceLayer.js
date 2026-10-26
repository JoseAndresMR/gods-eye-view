// Read-only bridge to the local intelligence layer (a separate process on this
// machine), plus saving its areas of interest. Only allowlisted resources are
// forwarded, so this route can never be used to reach anything else.
// Also the intelligence layer's windows onto public data GEV doesn't serve
// itself: NASA's granule catalog (CMR), which HLS scenes (Sentinel-2,
// Landsat 8/9) were acquired over a box, as the Recent Imagery layer searches;
// DeFlock's hourly licence-plate-reader tiles, as the ALPR layer reads; and
// the CelesTrak groups the IL's satellite relations need beyond the ones GEV's
// own /api/celestrak allows (upstream bounds that route to its layers' groups).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { celestrakTleUrl } from '../../src/data/spaceProviderRequests.js';
import { providerCooldownMs } from './space/cooldown.js';

const IL_API_BASE = (process.env.IL_API_BASE || 'http://127.0.0.1:8700').replace(/\/+$/, '');
const IL_TIMEOUT_MS = 5000;
const MAX_AREAS_BODY = 64 * 1024;
// A link distance in km as the intelligence layer names it: "5", "20", "0.25".
const DISTANCE_KM = /^(?:[1-9]\d{0,3}(?:\.\d{1,3})?|0\.\d{0,2}[1-9])$/;
const KINDS = new Set([
  'aircraft', 'vessels', 'military', 'satellites', 'fires', 'gnss',
  'military-areas', 'datacenters', 'dams', 'landings', 'cameras',
]);
/** Cross-layer satellite relations; each names the cluster feeds it observes. */
const RELATIONS = new Set([
  'imaging', 'fire', 'weather', 'receivers', 'navigation', 'imaged',
  'cameras', 'alpr', 'street', 'overflights',
]);
const MAX_OBSERVED_TARGETS = 8;
/** Cluster feeds that act as observers (overflights). */
const OBSERVER_KINDS = new Set(['aircraft', 'military']);

const CMR_GRANULES = 'https://cmr.earthdata.nasa.gov/search/granules.umm_json';
/** HLS collections (as in src/layers/recentImagery/model.js PRODUCTS). */
const HLS_COLLECTIONS = Object.freeze({ S30: 'C2021957295-LPCLOUD', L30: 'C2021957657-LPCLOUD' });
const IMAGERY_PAGE_SIZE = 200;
const IMAGERY_MAX_DAYS = 31;
const IMAGERY_MAX_SPAN_DEG = 5;
const IMAGERY_TIMEOUT_MS = 20000;
/** Answers are reused this long: scenes arrive a few times a day, and CMR asks for restraint. */
const IMAGERY_CACHE_MS = 30 * 60 * 1000;
const IMAGERY_CACHE_MAX = 1000;
const CURSOR = /^[\x21-\x7e]{1,512}$/;
const DAY_MS = 86400000;

const ALPR_TILES = 'https://tiles.dontgetflocked.com/cameras-{country}-hourly/{z}/{x}/{y}.mvt';
const ALPR_COUNTRIES = new Set(['us', 'ca']);
/** DeFlock carries full detail from z9; the IL reads z10 tiles. */
const ALPR_MIN_ZOOM = 9;
const ALPR_MAX_ZOOM = 14;
/** DeFlock rebuilds its tiles hourly. */
const ALPR_CACHE_MS = 60 * 60 * 1000;
const ALPR_CACHE_MAX = 2000;
const ALPR_TIMEOUT_MS = 20000;
const ALPR_MAX_BYTES = 2 * 1024 * 1024;

/** CelesTrak groups only the IL reads (GEV's /api/celestrak serves its own layers' groups). */
const IL_CELESTRAK_GROUPS = new Set(['resource', 'planet', 'weather', 'spire', 'orbcomm', 'iridium-NEXT', 'sarsat']);
/** CelesTrak asks for no more than one fetch per group every ~2 h; GEV's own route keeps 6 h. */
const IL_TLE_TTL_MS = 6 * 3600_000;
const IL_TLE_TIMEOUT_MS = 20000;
const IL_TLE_MAX_BYTES = 16 * 1024 * 1024;
const IL_TLE_CACHE_DIR = path.join(process.cwd(), '.gev-cache');

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
 *   GET /observability/<relation>?targets=<kind>:<km>,…[&bbox=W,S,E,N] → /api/observability/<relation>?…
 *   GET|PUT /areas                     → /api/areas
 */
export function intelligenceLayerPath(method, url) {
  const { pathname, searchParams } = new URL(url || '', 'http://localhost');
  const [, first, rest, extra] = pathname.split('/');
  if (first === 'areas' && rest === undefined)
    return method === 'GET' || method === 'PUT' ? '/api/areas' : null;
  if (first === 'observability')
    return method === 'GET' && RELATIONS.has(rest) && extra === undefined ? observabilityPath(rest, searchParams) : null;
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

function observabilityPath(relation, searchParams) {
  const targets = (searchParams.get('targets') || '').split(',').filter(Boolean);
  if (targets.length > MAX_OBSERVED_TARGETS) return null;
  for (const target of targets) {
    const [kind, km, more] = target.split(':');
    if (more !== undefined || !KINDS.has(kind) || !DISTANCE_KM.test(km || '')) return null;
  }
  const rawBbox = searchParams.get('bbox');
  const bbox = parseBbox(rawBbox);
  if (rawBbox && !bbox) return null;
  // Overflights name the aircraft lanes on show as observers.
  const observers = (searchParams.get('observers') || '').split(',').filter(Boolean);
  if (observers.length > 2) return null;
  for (const lane of observers) {
    const [kind, km, more] = lane.split(':');
    if (more !== undefined || !OBSERVER_KINDS.has(kind) || !DISTANCE_KM.test(km || '')) return null;
  }
  return `/api/observability/${relation}?targets=${targets.join(',')}` +
    `${observers.length ? `&observers=${observers.join(',')}` : ''}${bbox ? `&bbox=${bbox}` : ''}`;
}

/**
 * The CMR request for an imagery read, or null when it isn't allowed.
 *   GET /imagery?product=S30|L30&bbox=W,S,E,N&start=<ISO>&end=<ISO>[&cursor=<CMR-Search-After>]
 * The box spans at most 5° a side; the window at most 31 days, ending by tomorrow.
 * @returns {{url: string, cursor: string|null}|null}
 */
export function imageryRequest(url) {
  const { pathname, searchParams } = new URL(url || '', 'http://localhost');
  if (pathname !== '/imagery') return null;
  const collection = HLS_COLLECTIONS[searchParams.get('product')];
  const bbox = parseBbox(searchParams.get('bbox'));
  if (!collection || !bbox) return null;
  const [w, s, e, n] = bbox.split(',').map(Number);
  if (e - w > IMAGERY_MAX_SPAN_DEG || e < w || n - s > IMAGERY_MAX_SPAN_DEG) return null;
  const start = Date.parse(searchParams.get('start') || '');
  const end = Date.parse(searchParams.get('end') || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start > IMAGERY_MAX_DAYS * DAY_MS || end > Date.now() + DAY_MS) return null;
  const cursor = searchParams.get('cursor');
  if (cursor !== null && !CURSOR.test(cursor)) return null;
  return {
    url:
      `${CMR_GRANULES}?collection_concept_id=${collection}&bounding_box=${bbox}` +
      `&temporal=${new Date(start).toISOString()},${new Date(end).toISOString()}` +
      `&sort_key=-start_date&page_size=${IMAGERY_PAGE_SIZE}`,
    cursor,
  };
}

/**
 * The DeFlock tile URL for an ALPR tile read, or null when it isn't allowed.
 *   GET /alpr/<us|ca>/<z>/<x>/<y>   (z 9–14)
 */
export function alprTileUrl(url) {
  const { pathname } = new URL(url || '', 'http://localhost');
  const match = /^\/alpr\/([a-z]{2})\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})$/.exec(pathname);
  if (!match || !ALPR_COUNTRIES.has(match[1])) return null;
  const [z, x, y] = match.slice(2).map(Number);
  if (z < ALPR_MIN_ZOOM || z > ALPR_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
  return ALPR_TILES.replace('{country}', match[1]).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

const _alprCache = new Map(); // url -> { at, bytes }

async function serveAlprTile(res, url) {
  const cached = _alprCache.get(url);
  let bytes = cached && Date.now() - cached.at < ALPR_CACHE_MS ? cached.bytes : null;
  if (!bytes) {
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(ALPR_TIMEOUT_MS) });
      if (upstream.status === 404 || upstream.status === 204) bytes = Buffer.alloc(0);
      else if (!upstream.ok) {
        sendJson(res, 502, { error: `DeFlock tiles answered HTTP ${upstream.status}` });
        return;
      } else {
        bytes = Buffer.from(await upstream.arrayBuffer());
        if (bytes.length > ALPR_MAX_BYTES) {
          sendJson(res, 502, { error: 'DeFlock tile too large' });
          return;
        }
      }
    } catch {
      sendJson(res, 503, { error: 'DeFlock tiles not reachable' });
      return;
    }
    if (_alprCache.size >= ALPR_CACHE_MAX) _alprCache.delete(_alprCache.keys().next().value);
    _alprCache.set(url, { at: Date.now(), bytes });
  }
  res.statusCode = bytes.length ? 200 : 204;
  res.setHeader('Content-Type', 'application/x-protobuf');
  res.setHeader('Cache-Control', 'no-store');
  res.end(bytes.length ? bytes : undefined);
}

/** The CelesTrak group of a TLE read, or null when it isn't one the IL may read. GET /celestrak/<group> */
export function ilCelestrakGroup(url) {
  const { pathname } = new URL(url || '', 'http://localhost');
  const match = /^\/celestrak\/([A-Za-z-]{1,32})$/.exec(pathname);
  return match && IL_CELESTRAK_GROUPS.has(match[1]) ? match[1] : null;
}

const _tleMem = new Map(); // group -> { at, body }
const _tleInflight = new Map(); // group -> Promise<{ at, body }>
let _tleCooldownUntil = 0;
const tleDiskPath = (group) => path.join(IL_TLE_CACHE_DIR, `il-celestrak-${group}.json`);

async function fetchTleGroup(group) {
  const res = await fetch(celestrakTleUrl(group).toString(), {
    signal: AbortSignal.timeout(IL_TLE_TIMEOUT_MS),
    // As GEV's own route: CelesTrak refuses bulk groups without a descriptive User-Agent.
    headers: { 'User-Agent': 'gods-eye-view-intelligence-layer/1.0 (+https://github.com/JoseAndresMR/gods-eye-view)' },
  });
  if (!res.ok) {
    _tleCooldownUntil = Math.max(_tleCooldownUntil, Date.now() + providerCooldownMs(res));
    void res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.text();
  if (body.length > IL_TLE_MAX_BYTES || !/^1 /m.test(body)) throw new Error('no TLE lines in response');
  const entry = { at: Date.now(), body };
  try {
    await fsp.mkdir(IL_TLE_CACHE_DIR, { recursive: true });
    await fsp.writeFile(tleDiskPath(group), JSON.stringify(entry), 'utf8');
  } catch {
    // a missing disk cache only costs a refetch after restart
  }
  return entry;
}

/** One group's TLEs: fresh cache, else one upstream fetch per group at a time, else a stale copy. */
async function serveTleGroup(res, group) {
  let entry = _tleMem.get(group);
  if (!entry) {
    try {
      entry = JSON.parse(await fsp.readFile(tleDiskPath(group), 'utf8'));
      if (typeof entry?.body !== 'string' || !Number.isFinite(entry?.at)) entry = null;
      else _tleMem.set(group, entry);
    } catch {
      entry = null;
    }
  }
  const sendTle = (e, cache) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-tle-cache', cache);
    res.setHeader('X-TLE-Cached-At', new Date(e.at).toISOString());
    res.end(e.body);
  };
  if (entry && Date.now() - entry.at < IL_TLE_TTL_MS) return sendTle(entry, 'HIT');
  if (Date.now() < _tleCooldownUntil) {
    if (entry) return sendTle(entry, 'STALE');
    res.setHeader('Retry-After', String(Math.ceil((_tleCooldownUntil - Date.now()) / 1000)));
    return sendJson(res, 503, { error: 'CelesTrak cooling down' });
  }
  try {
    if (!_tleInflight.has(group)) _tleInflight.set(group, fetchTleGroup(group).finally(() => _tleInflight.delete(group)));
    const fresh = await _tleInflight.get(group);
    _tleMem.set(group, fresh);
    return sendTle(fresh, 'MISS');
  } catch {
    if (entry) return sendTle(entry, 'STALE');
    return sendJson(res, 502, { error: 'CelesTrak not reachable' });
  }
}

function ringOf(points) {
  return (points || [])
    .map((p) => [Number(p?.Longitude), Number(p?.Latitude)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

/** A CMR granules.umm_json page reduced to what the intelligence layer reads. */
export function slimGranules(json) {
  const items = [];
  for (const item of Array.isArray(json?.items) ? json.items : []) {
    const umm = item?.umm || {};
    const range = umm.TemporalExtent?.RangeDateTime || {};
    if (!range.BeginningDateTime) continue;
    const cloud = (umm.AdditionalAttributes || []).find((a) => a?.Name === 'CLOUD_COVERAGE')?.Values?.[0];
    const geometry = umm.SpatialExtent?.HorizontalSpatialDomain?.Geometry || {};
    const footprint = [
      ...(geometry.GPolygons || []).map((g) => ringOf(g?.Boundary?.Points)),
      ...(geometry.BoundingRectangles || []).map((r) => [
        [r.WestBoundingCoordinate, r.SouthBoundingCoordinate],
        [r.EastBoundingCoordinate, r.SouthBoundingCoordinate],
        [r.EastBoundingCoordinate, r.NorthBoundingCoordinate],
        [r.WestBoundingCoordinate, r.NorthBoundingCoordinate],
      ]),
    ].filter((ring) => ring.length >= 3);
    items.push({
      id: String(item?.meta?.['concept-id'] || umm.GranuleUR || ''),
      name: String(umm.GranuleUR || ''),
      start: range.BeginningDateTime,
      end: range.EndingDateTime || range.BeginningDateTime,
      cloud: Number.isFinite(Number(cloud)) && cloud !== '' ? Number(cloud) : null,
      platforms: (umm.Platforms || []).map((p) => String(p?.ShortName || '')).filter(Boolean),
      footprint,
    });
  }
  return { hits: Number(json?.hits) || items.length, items };
}

const _imageryCache = new Map(); // `${url}|${cursor}` -> { at, body }

async function serveImagery(req, res, request) {
  const key = `${request.url}|${request.cursor || ''}`;
  const cached = _imageryCache.get(key);
  if (cached && Date.now() - cached.at < IMAGERY_CACHE_MS) {
    sendJson(res, 200, cached.body);
    return;
  }
  try {
    const headers = request.cursor ? { 'CMR-Search-After': request.cursor } : {};
    const upstream = await fetch(request.url, { headers, signal: AbortSignal.timeout(IMAGERY_TIMEOUT_MS) });
    if (!upstream.ok) {
      sendJson(res, 502, { error: `NASA CMR answered HTTP ${upstream.status}` });
      return;
    }
    const body = { ...slimGranules(await upstream.json()), cursor: upstream.headers.get('CMR-Search-After') };
    if (_imageryCache.size >= IMAGERY_CACHE_MAX) _imageryCache.delete(_imageryCache.keys().next().value);
    _imageryCache.set(key, { at: Date.now(), body });
    sendJson(res, 200, body);
  } catch {
    sendJson(res, 503, { error: 'NASA CMR not reachable' });
  }
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
 * (cluster feeds, their satellite observation, areas of interest), and
 * /api/il/imagery → NASA CMR (HLS scenes over a box), /api/il/alpr → DeFlock tiles,
 * /api/il/celestrak/<group> → CelesTrak TLE groups only the IL reads.
 */
export function intelligenceLayerProxy() {
  function install(middlewares) {
    middlewares.use('/api/il', async (req, res) => {
      if (req.method === 'GET' && new URL(req.url || '', 'http://localhost').pathname.startsWith('/celestrak/')) {
        const group = ilCelestrakGroup(req.url);
        if (group) await serveTleGroup(res, group);
        else sendJson(res, 400, { error: 'celestrak groups here are ' + [...IL_CELESTRAK_GROUPS].join(', ') });
        return;
      }
      if (req.method === 'GET' && new URL(req.url || '', 'http://localhost').pathname.startsWith('/alpr/')) {
        const url = alprTileUrl(req.url);
        if (url) await serveAlprTile(res, url);
        else sendJson(res, 400, { error: 'alpr tiles are /alpr/<us|ca>/<z 9–14>/<x>/<y>' });
        return;
      }
      if (req.method === 'GET' && new URL(req.url || '', 'http://localhost').pathname === '/imagery') {
        const request = imageryRequest(req.url);
        if (request) await serveImagery(req, res, request);
        else sendJson(res, 400, { error: 'imagery needs product=S30|L30, a bbox of at most 5°, and start/end within 31 days' });
        return;
      }
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
