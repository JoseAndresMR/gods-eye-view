// Areas of interest: where the intelligence layer computes. Pure helpers and
// the load/save calls; the INTELLIGENCE panel owns the UI.
import { msg } from '../../i18n/index.js';
import { IL_AREAS_URL } from './model.js';

export const MAX_AREAS = 50;
/** Smallest box side accepted, in degrees (~1 km); smaller drags are slips. */
const MIN_SIDE_DEG = 0.01;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The document the IL starts from: worldwide, no boxes. */
export const DEFAULT_AREAS = Object.freeze({ global: true, areas: [] });

/**
 * Box-tool validator for an area: any size on one side of the dateline.
 * @returns {{ok: true, box: object} | {ok: false, reason: string, message: string}}
 */
export function validateAreaBox(box) {
  const { west, south, east, north } = box || {};
  if (![west, south, east, north].every(finite))
    return { ok: false, reason: 'invalid', message: msg('Box edges must be finite') };
  if (east - west < MIN_SIDE_DEG || north - south < MIN_SIDE_DEG)
    return { ok: false, reason: 'degenerate', message: msg('Drag to size the box') };
  const round = (v) => Number(v.toFixed(4));
  return {
    ok: true,
    box: {
      west: round(Math.max(-180, west)),
      south: round(Math.max(-90, south)),
      east: round(Math.min(180, east)),
      north: round(Math.min(90, north)),
    },
  };
}

/** Most polygon points the IL accepts. */
export const MAX_POLYGON_POINTS = 500;

/**
 * Polygon-tool validator: 3+ distinct finite points that enclose something.
 * Returns the area fields (the bounding box the IL filters by, and the ring).
 */
export function validateAreaPolygon(points) {
  const ring = (points || []).filter((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));
  if (ring.length < 3) return { ok: false, reason: 'degenerate', message: msg('Click at least three points') };
  if (ring.length > MAX_POLYGON_POINTS) return { ok: false, reason: 'invalid', message: msg('Too many points') };
  const round = (v) => Number(v.toFixed(4));
  const clean = ring.map(([lon, lat]) => [round(Math.max(-180, Math.min(180, lon))), round(Math.max(-90, Math.min(90, lat)))]);
  const lons = clean.map((p) => p[0]);
  const lats = clean.map((p) => p[1]);
  const box = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
  if (box.east - box.west < MIN_SIDE_DEG || box.north - box.south < MIN_SIDE_DEG)
    return { ok: false, reason: 'degenerate', message: msg('Click at least three points') };
  return { ok: true, box: { ...box, polygon: clean } };
}

/** A new id not used by `areas`. */
export function nextAreaId(areas) {
  const used = new Set((areas || []).map((a) => a.id));
  let n = (areas || []).length + 1;
  while (used.has(`a${n}`)) n += 1;
  return `a${n}`;
}

/** The document with one area added (enabled), or null when full. */
export function addArea(doc, box, name) {
  if (doc.areas.length >= MAX_AREAS) return null;
  const id = nextAreaId(doc.areas);
  return { ...doc, areas: [...doc.areas, { id, name, enabled: true, ...box }] };
}

export function updateArea(doc, id, changes) {
  return { ...doc, areas: doc.areas.map((a) => (a.id === id ? { ...a, ...changes } : a)) };
}

export function removeArea(doc, id) {
  return { ...doc, areas: doc.areas.filter((a) => a.id !== id) };
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

export async function loadAreas(fetchImpl = globalThis.fetch) {
  return readJson(await fetchImpl(IL_AREAS_URL, { cache: 'no-store' }));
}

/** Save the whole document; resolves to what the IL stored. */
export async function saveAreas(doc, fetchImpl = globalThis.fetch) {
  return readJson(
    await fetchImpl(IL_AREAS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    }),
  );
}
