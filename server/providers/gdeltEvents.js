import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  aggregateGdeltProject,
  mergeConflictEvents,
  normalizeGdeltCloudRows,
  parseGdeltProjectExport,
} from '../../src/data/conflictEvents.js';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from './common/http.js';
import { readFirstZipEntry } from './common/zip.js';

/**
 * GDELT conflict-event proxy with two sources behind one route.
 *
 * - **GDELT Project** (free, keyless): the 15-minute GDELT 2.0 export files at
 *   data.gdeltproject.org. The server keeps a rolling 24 h of the conflict-
 *   root actions (CAMEO 14/18/19/20 with a city-level location) and
 *   aggregates them per place and day.
 * - **GDELT Cloud** (`GDELT_API_KEY`, free plan = 50 query units a month):
 *   one call a day for the top-100 events by significance over the last two
 *   days. A hard monthly call cap keeps the key from running dry; the count is
 *   persisted, and incremented before the call so a crash cannot undercount.
 *
 * Routes:
 *   GET /api/gdelt-events[?free=0]  → {fetchedAt, free, cloud, count, events}
 *   GET /api/gdelt-events/status    → {free, cloud} (no upstream traffic)
 *
 * `free=0` leaves the free feed out of `events` (the UI's switch); Cloud
 * events are always included when there are any. Without a key Cloud reports
 * `no_key` and the free feed still works. Never log the key.
 *
 * @param {object} [options] Injection points for tests.
 * @returns {import('vite').Plugin}
 */
export function gdeltEventsProxy({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir = path.join(process.cwd(), '.gev-cache'),
} = {}) {
  const SLOT_MS = 15 * 60_000;
  const FREE_WINDOW_MS = 24 * 60 * 60_000;
  /** The newest slot is announced before it is downloadable; retry for a while. */
  const FREE_RETRY_MS = 90 * 60_000;
  const FREE_COLD_SLOTS = 12;
  const FREE_MAX_ZIP_BYTES = 8 * 1024 * 1024;
  const FREE_MAX_TEXT_BYTES = 48 * 1024 * 1024;
  const FREE_BASE = 'https://data.gdeltproject.org/gdeltv2/';
  const CLOUD_URL = 'https://gdeltcloud.com/api/v2/events';
  const CLOUD_TTL_MS = 24 * 60 * 60_000;
  const CLOUD_MONTHLY_CAP = 45; // plan allowance is 50 units
  const CLOUD_CATEGORIES = [
    'Battles',
    'Explosions/Remote violence',
    'Violence against civilians',
    'Riots',
    'Protests',
    'Strategic developments',
  ];
  const FREE_PATH = path.join(cacheDir, 'gdelt-project.json');
  const CLOUD_PATH = path.join(cacheDir, 'gdelt-cloud.json');

  /** @type {Map<string, Array<object>>} slot id (YYYYMMDDHHMMSS) → raw records */
  const slots = new Map();
  let freeLoaded = false;
  let freeAt = null;
  let freeError = null;
  let freeInflight = null;
  let freeAggregate = { signature: '', events: [] };

  const cloud = {
    loaded: false,
    at: null,
    events: [],
    usage: { month: '', calls: 0 },
    nextTryAt: 0,
    error: null,
    inflight: null,
  };

  const apiKey = () => String(env.GDELT_API_KEY || '').trim();
  const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

  const slotId = (ms) =>
    new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slotMs = (id) =>
    Date.parse(
      `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:00Z`,
    );

  async function writeJson(file, value) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(file, JSON.stringify(value), 'utf8');
    } catch (err) {
      console.warn('[gdelt-events] cache write failed:', err?.message || err);
    }
  }
  async function readJson(file) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async function loadOnce() {
    if (!freeLoaded) {
      freeLoaded = true;
      const disk = await readJson(FREE_PATH);
      if (disk && typeof disk.slots === 'object' && disk.slots) {
        for (const [id, rows] of Object.entries(disk.slots)) {
          if (/^\d{14}$/.test(id) && Array.isArray(rows)) slots.set(id, rows);
        }
        freeAt = Number.isFinite(disk.at) ? disk.at : null;
      }
    }
    if (!cloud.loaded) {
      cloud.loaded = true;
      const disk = await readJson(CLOUD_PATH);
      if (disk && Array.isArray(disk.events)) {
        cloud.at = Number.isFinite(disk.at) ? disk.at : null;
        cloud.events = disk.events;
        cloud.nextTryAt = Number.isFinite(disk.nextTryAt) ? disk.nextTryAt : 0;
      }
      if (disk?.usage && typeof disk.usage.month === 'string') {
        cloud.usage = {
          month: disk.usage.month,
          calls: Number(disk.usage.calls) || 0,
        };
      }
    }
  }

  const persistCloud = () =>
    writeJson(CLOUD_PATH, {
      at: cloud.at,
      events: cloud.events,
      usage: cloud.usage,
      nextTryAt: cloud.nextTryAt,
    });

  // ---- free GDELT Project feed -------------------------------------------

  function wantedSlots(at) {
    const newest = Math.floor(at / SLOT_MS) * SLOT_MS;
    const out = [];
    for (let ms = newest; ms > at - FREE_WINDOW_MS; ms -= SLOT_MS) {
      out.push(slotId(ms));
    }
    return out; // newest first
  }

  async function fetchSlot(id) {
    const signal = AbortSignal.timeout(25_000);
    const res = await fetchImpl(`${FREE_BASE}${id}.export.CSV.zip`, {
      signal,
      redirect: 'follow',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const zip = await readResponseBytesCapped(res, FREE_MAX_ZIP_BYTES, signal);
    const body = readFirstZipEntry(zip, FREE_MAX_TEXT_BYTES).toString('utf8');
    return parseGdeltProjectExport(body);
  }

  /** Fetch the missing slots newest-first; `limit` bounds this pass. */
  async function freePass(limit) {
    const at = now();
    const wanted = wantedSlots(at);
    const wantedSet = new Set(wanted);
    for (const id of slots.keys()) if (!wantedSet.has(id)) slots.delete(id);
    let fetched = 0;
    let failures = 0;
    for (const id of wanted) {
      if (slots.has(id)) continue;
      if (limit !== undefined && fetched >= limit) break;
      try {
        const rows = await fetchSlot(id);
        if (rows) {
          slots.set(id, rows);
          fetched++;
        } else if (at - slotMs(id) > FREE_RETRY_MS) {
          slots.set(id, []); // permanently absent: stop asking
        }
        failures = 0;
      } catch (err) {
        freeError = err?.message || String(err);
        console.warn(`[gdelt-events] slot ${id} failed:`, freeError);
        if (++failures >= 3) break;
      }
    }
    if (fetched) freeError = null;
    freeAt = at;
    await writeJson(FREE_PATH, {
      at: freeAt,
      slots: Object.fromEntries(slots),
    });
    return fetched;
  }

  async function ensureFree() {
    const stale = freeAt === null || now() - freeAt >= SLOT_MS;
    if (!stale) return;
    if (!freeInflight) {
      const cold = slots.size === 0;
      freeInflight = freePass(cold ? FREE_COLD_SLOTS : undefined)
        .then(() => {
          // Cold start returns after the newest few hours; fill the rest
          // in the background rather than holding the request.
          if (cold) {
            freeInflight = freePass().finally(() => {
              freeInflight = null;
            });
            freeInflight.catch(() => {});
          }
        })
        .catch((err) => {
          freeError = err?.message || String(err);
        })
        .finally(() => {
          if (!cold) freeInflight = null;
        });
    }
    if (slots.size === 0) await freeInflight;
  }

  function freeEvents() {
    const signature = [...slots.keys()].sort().join(',');
    if (freeAggregate.signature !== signature) {
      const records = [];
      for (const rows of slots.values()) for (const r of rows) records.push(r);
      freeAggregate = { signature, events: aggregateGdeltProject(records) };
    }
    return freeAggregate.events;
  }

  // ---- GDELT Cloud (metered) ---------------------------------------------

  function cloudStatus(at) {
    if (!apiKey()) return 'no_key';
    if (
      cloud.usage.month === monthOf(at) &&
      cloud.usage.calls >= CLOUD_MONTHLY_CAP
    )
      return 'budget';
    if (at < cloud.nextTryAt) return cloud.events.length ? 'ready' : 'cooldown';
    return cloud.events.length ? 'ready' : 'idle';
  }

  async function ensureCloud() {
    const at = now();
    const key = apiKey();
    if (!key) return;
    if (cloud.at !== null && at - cloud.at < CLOUD_TTL_MS) return;
    if (at < cloud.nextTryAt) return;
    const month = monthOf(at);
    if (cloud.usage.month !== month) cloud.usage = { month, calls: 0 };
    if (cloud.usage.calls >= CLOUD_MONTHLY_CAP) return;
    if (cloud.inflight) return cloud.inflight;
    cloud.inflight = (async () => {
      // Count first: a crash mid-call must not hide a spent unit.
      cloud.usage.calls += 1;
      cloud.nextTryAt = at + 60 * 60_000;
      await persistCloud();
      try {
        const params = new URLSearchParams({
          days: '2',
          limit: '100',
          sort: 'significance',
          category: CLOUD_CATEGORIES.join(','),
        });
        const signal = AbortSignal.timeout(20_000);
        const res = await fetchImpl(`${CLOUD_URL}?${params}`, {
          signal,
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) {
          // Plan, auth and rate failures will not fix themselves within the hour.
          if ([401, 402, 403, 429].includes(res.status))
            cloud.nextTryAt = at + 6 * 60 * 60_000;
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await readResponseJsonCapped(
          res,
          4 * 1024 * 1024,
          signal,
        );
        if (!payload?.success || !Array.isArray(payload.data))
          throw new Error('malformed GDELT Cloud response');
        cloud.events = normalizeGdeltCloudRows(payload.data);
        cloud.at = now();
        cloud.nextTryAt = 0;
        cloud.error = null;
      } catch (err) {
        cloud.error = err?.message || String(err);
        console.warn('[gdelt-events] cloud refresh failed:', cloud.error);
      } finally {
        await persistCloud();
        cloud.inflight = null;
      }
    })();
    return cloud.inflight;
  }

  function meta(at, wantFree) {
    return {
      free: {
        enabled: wantFree,
        status:
          freeError && slots.size === 0
            ? 'error'
            : slots.size
              ? 'ready'
              : 'idle',
        fetchedAt: freeAt,
        slots: slots.size,
        error: freeError,
      },
      cloud: {
        status: cloudStatus(at),
        fetchedAt: cloud.at,
        count: cloud.events.length,
        error: cloud.error,
        budget: {
          month: monthOf(at),
          used: cloud.usage.month === monthOf(at) ? cloud.usage.calls : 0,
          cap: CLOUD_MONTHLY_CAP,
        },
      },
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/gdelt-events', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method && req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const [subPath, query = ''] = String(req.url || '').split('?');
        const wantFree = new URLSearchParams(query).get('free') !== '0';
        await loadOnce();
        if (subPath === '/status') {
          sendJson(200, meta(now(), wantFree));
          return;
        }
        if (subPath && subPath !== '/' && subPath !== '') {
          sendJson(404, { error: 'not_found' });
          return;
        }
        await Promise.all([wantFree ? ensureFree() : null, ensureCloud()]);
        const at = now();
        const state = meta(at, wantFree);
        const cloudEvents = cloud.events;
        const events = wantFree
          ? mergeConflictEvents([...cloudEvents, ...freeEvents()])
          : mergeConflictEvents(cloudEvents);
        if (
          !events.length &&
          state.cloud.status !== 'ready' &&
          state.free.status === 'error'
        ) {
          sendJson(502, { error: 'gdelt_unavailable', ...state });
          return;
        }
        sendJson(200, {
          fetchedAt:
            Math.max(cloud.at ?? 0, wantFree ? (freeAt ?? 0) : 0) || null,
          ...state,
          count: events.length,
          events,
        });
      } catch (err) {
        console.warn('[gdelt-events] error:', err?.message || err);
        sendJson(500, { error: 'gdelt proxy error' });
      }
    });
  };

  return {
    name: 'gdelt-events-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
