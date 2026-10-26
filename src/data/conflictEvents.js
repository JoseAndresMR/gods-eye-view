/**
 * Conflict / unrest event records shared by the GDELT layer and its server
 * provider. Pure: no Cesium, no fetch, no clock.
 *
 * Every source is reduced to one event shape:
 *   {id, source, family, category, subcategory, date, dateMs, lat, lon,
 *    precision, place, country, admin1, title, summary, fatalities, url,
 *    mentions}
 * Actor names are deliberately not carried: this is aggregate situational
 * awareness, never a view of named people.
 * `source` is 'gdelt-cloud' | 'gdelt-project'. `family` is the ACLED-style
 * event-type taxonomy, which GDELT Cloud's conflict family uses; the
 * free GDELT Project feed (CAMEO) is mapped onto it by root code.
 */

/** Display order and colours; labels live with the UI (layers/gdeltEvents/families.js). */
export const CONFLICT_FAMILIES = Object.freeze({
  battles: { color: '#e5484d' },
  explosions: { color: '#f76b15' },
  civilians: { color: '#d6409f' },
  riots: { color: '#ffb224' },
  protests: { color: '#3e63dd' },
  strategic: { color: '#8d8d8d' },
});

const FAMILY_BY_CATEGORY = Object.freeze({
  battles: 'battles',
  'explosions/remote violence': 'explosions',
  'violence against civilians': 'civilians',
  riots: 'riots',
  protests: 'protests',
  'strategic developments': 'strategic',
});

/** CAMEO root codes the free GDELT Project feed contributes. */
const FAMILY_BY_CAMEO_ROOT = Object.freeze({
  14: 'protests',
  18: 'civilians',
  19: 'battles',
  20: 'civilians',
});
const CAMEO_ROOT_LABEL = Object.freeze({
  14: 'Protest',
  18: 'Assault',
  19: 'Fighting',
  20: 'Mass violence',
});

export const SOURCE_PRIORITY = Object.freeze(['gdelt-cloud', 'gdelt-project']);

export function conflictFamilyOf(category) {
  return (
    FAMILY_BY_CATEGORY[
      String(category ?? '')
        .trim()
        .toLowerCase()
    ] || null
  );
}

const text = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const validLatLon = (lat, lon) =>
  lat !== null &&
  lon !== null &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  !(lat === 0 && lon === 0);
const dayMs = (date) => {
  const ms = Date.parse(`${String(date ?? '').slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

/** GDELT Cloud `/api/v2/events` rows (conflict family only) → events. */
export function normalizeGdeltCloudRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const family = conflictFamilyOf(row?.category);
    const lat = num(row?.geo?.latitude);
    const lon = num(row?.geo?.longitude);
    const dateMs = dayMs(row?.event_date);
    const id = text(row?.id);
    if (!family || !id || dateMs === null || !validLatLon(lat, lon)) continue;
    out.push({
      id: `gdelt-cloud:${id}`,
      source: 'gdelt-cloud',
      family,
      category: text(row.category),
      subcategory: text(row.subcategory_label) || text(row.subcategory),
      date: String(row.event_date).slice(0, 10),
      dateMs,
      lat,
      lon,
      precision: num(row.geo?.geo_precision),
      place: text(row.geo?.location),
      country: text(row.geo?.country),
      admin1: text(row.geo?.admin1),
      title: text(row.title),
      summary: text(row.summary),
      fatalities: num(row.fatalities),
      url: safeHttpUrl(row.primary_story_url) || safeHttpUrl(row.url),
      mentions: num(row.metrics?.article_count),
    });
  }
  return out;
}

export function safeHttpUrl(value) {
  try {
    const u = new URL(String(value ?? ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * One GDELT 2.0 export file (tab separated, 61 columns) → raw action records
 * for CAMEO roots 14/18/19/20 that have a city-level action location.
 * Column indexes follow the GDELT 2.0 event codebook (0-based).
 */
export function parseGdeltProjectExport(body) {
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length < 61) continue;
    const root = Number(c[28]);
    if (!FAMILY_BY_CAMEO_ROOT[root]) continue;
    // ActionGeo_Type 3 = US city, 4 = world city. Country/state-level
    // centroids would draw misleading points, so they are skipped.
    if (c[51] !== '3' && c[51] !== '4') continue;
    const lat = num(c[56]);
    const lon = num(c[57]);
    if (!validLatLon(lat, lon)) continue;
    out.push({
      root,
      code: text(c[26]),
      sqldate: text(c[1]),
      place: text(c[52]),
      country: text(c[53]),
      lat,
      lon,
      mentions: num(c[31]) ?? 1,
      goldstein: num(c[30]),
      tone: num(c[34]),
      url: safeHttpUrl(c[60]),
    });
  }
  return out;
}

/**
 * Collapse raw GDELT Project records into one event per (root, ~1 km cell,
 * day), summing mentions and keeping the most-mentioned article as the link.
 * Output is ranked by mentions and capped, so the layer stays drawable.
 */
export function aggregateGdeltProject(records, { limit = 1500 } = {}) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.root}|${r.lat.toFixed(2)},${r.lon.toFixed(2)}|${r.sqldate}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...r, events: 1, topMentions: r.mentions });
      continue;
    }
    g.events += 1;
    g.mentions += r.mentions;
    if (r.mentions > g.topMentions) {
      g.topMentions = r.mentions;
      g.url = r.url || g.url;
    }
  }
  const events = [];
  for (const [key, g] of groups) {
    const dateMs = dayMs(
      g.sqldate &&
        `${g.sqldate.slice(0, 4)}-${g.sqldate.slice(4, 6)}-${g.sqldate.slice(6, 8)}`,
    );
    if (dateMs === null) continue;
    const label = CAMEO_ROOT_LABEL[g.root];
    events.push({
      id: `gdelt-project:${key}`,
      source: 'gdelt-project',
      family: FAMILY_BY_CAMEO_ROOT[g.root],
      category: label,
      subcategory: null,
      date: new Date(dateMs).toISOString().slice(0, 10),
      dateMs,
      lat: g.lat,
      lon: g.lon,
      precision: 2,
      place: g.place,
      country: g.country,
      admin1: null,
      title: g.place ? `${label}: ${g.place}` : label,
      summary: null,
      fatalities: null,
      url: g.url,
      mentions: g.mentions,
    });
  }
  events.sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0));
  return events.slice(0, Math.max(0, limit));
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Merge events of different sources that describe the same thing: same family,
 * within `distanceKm` and `days` of each other. A group never holds two events
 * of the same source. The highest-priority member leads (GDELT Cloud, then
 * GDELT Project); `merged` holds the other sources' records (empty for
 * an unmatched event) and `sources` lists every source in priority order, so
 * callers render one list either way.
 */
export function mergeConflictEvents(
  events,
  { distanceKm = 10, days = 1 } = {},
) {
  const rank = (e) => {
    const i = SOURCE_PRIORITY.indexOf(e.source);
    return i < 0 ? SOURCE_PRIORITY.length : i;
  };
  const ordered = events.slice().sort((a, b) => rank(a) - rank(b));
  const cell = 0.25; // degrees, > distanceKm/111 for the default
  const cellKey = (lat, lon) =>
    `${Math.floor(lat / cell)},${Math.floor(lon / cell)}`;
  const grid = new Map();
  const groups = [];
  const window = days * 86_400_000;
  for (const e of ordered) {
    let found = null;
    const cy = Math.floor(e.lat / cell);
    const cx = Math.floor(e.lon / cell);
    search: for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const g of grid.get(`${cy + dy},${cx + dx}`) || []) {
          const lead = g.members[0];
          if (
            lead.family === e.family &&
            Math.abs(lead.dateMs - e.dateMs) <= window &&
            !g.members.some((m) => m.source === e.source) &&
            haversineKm(lead.lat, lead.lon, e.lat, e.lon) <= distanceKm
          ) {
            found = g;
            break search;
          }
        }
      }
    }
    if (found) {
      found.members.push(e);
      continue;
    }
    const g = { members: [e] };
    groups.push(g);
    const k = cellKey(e.lat, e.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(g);
  }
  return groups.map(({ members }) => ({
    ...members[0],
    id: members.length > 1 ? `merged:${members[0].id}` : members[0].id,
    sources: members.map((m) => m.source),
    merged: members.slice(1),
  }));
}
