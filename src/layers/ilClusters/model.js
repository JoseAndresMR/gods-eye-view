// Pure helpers for the intelligence-layer cluster overlays.
import {
  degreesLat,
  degreesLong,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';

export const IL_AIRCRAFT_CLUSTERS_ID = 'il-aircraft-clusters';
export const IL_VESSEL_CLUSTERS_ID = 'il-vessel-clusters';
export const IL_MILITARY_CLUSTERS_ID = 'il-military-clusters';
export const IL_SATELLITE_CLUSTERS_ID = 'il-satellite-clusters';
export const IL_FIRE_CLUSTERS_ID = 'il-fire-clusters';
export const IL_GNSS_ZONES_ID = 'il-gnss-zones';
export const IL_EVENT_CLUSTERS_ID = 'il-event-clusters';
export const IL_MILITARY_AREA_CLUSTERS_ID = 'il-military-area-clusters';
export const IL_DATACENTER_CLUSTERS_ID = 'il-datacenter-clusters';
export const IL_DAM_CLUSTERS_ID = 'il-dam-clusters';
export const IL_LANDING_CLUSTERS_ID = 'il-landing-clusters';
export const IL_CAMERA_CLUSTERS_ID = 'il-camera-clusters';
// Cross-layer: satellites observing the clusters of other IL layers.
export const IL_SAT_IMAGING_ID = 'il-sat-imaging';
export const IL_SAT_FIRE_ID = 'il-sat-fire';
export const IL_SAT_WEATHER_ID = 'il-sat-weather';
export const IL_SAT_RECEIVERS_ID = 'il-sat-receivers';
export const IL_SAT_NAVIGATION_ID = 'il-sat-navigation';
export const IL_SAT_IMAGED_ID = 'il-sat-imaged';
// Cross-layer: ground and air observers of the clusters of other IL layers.
export const IL_OBS_CAMERAS_ID = 'il-obs-cameras';
export const IL_OBS_ALPR_ID = 'il-obs-alpr';
export const IL_OBS_STREET_ID = 'il-obs-street';
export const IL_OBS_OVERFLIGHTS_ID = 'il-obs-overflights';

/** Every intelligence-layer overlay, in the order the Intelligence panel lists them. */
export const IL_LAYER_IDS = Object.freeze([
  IL_AIRCRAFT_CLUSTERS_ID,
  IL_MILITARY_CLUSTERS_ID,
  IL_VESSEL_CLUSTERS_ID,
  IL_SATELLITE_CLUSTERS_ID,
  IL_FIRE_CLUSTERS_ID,
  IL_GNSS_ZONES_ID,
  IL_EVENT_CLUSTERS_ID,
  IL_MILITARY_AREA_CLUSTERS_ID,
  IL_DATACENTER_CLUSTERS_ID,
  IL_DAM_CLUSTERS_ID,
  IL_LANDING_CLUSTERS_ID,
  IL_CAMERA_CLUSTERS_ID,
  IL_SAT_IMAGING_ID,
  IL_SAT_FIRE_ID,
  IL_SAT_WEATHER_ID,
  IL_SAT_RECEIVERS_ID,
  IL_SAT_NAVIGATION_ID,
  IL_SAT_IMAGED_ID,
  IL_OBS_CAMERAS_ID,
  IL_OBS_ALPR_ID,
  IL_OBS_STREET_ID,
  IL_OBS_OVERFLIGHTS_ID,
]);

const EARTH_RADIUS_M = 6371008.8;
const KNOT_MPS = 0.514444;

export const CLUSTER_PALETTE = Object.freeze([
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#9a6324', '#469990', '#808000', '#000075', '#bfef45',
]);

/** Stable colour per tracked cluster id ("C12"), matching the IL's own pages. */
export function clusterColorCss(clusterId) {
  const n = Number.parseInt(String(clusterId || '').slice(1), 10);
  return Number.isFinite(n) ? CLUSTER_PALETTE[n % CLUSTER_PALETTE.length] : '#9a9a94';
}

/** A distance as the intelligence layer names it in files: 20 -> "20", 2.5 -> "2.5". */
export function distanceLabel(km) {
  return String(Number(km));
}

/** @param {string} kind Intelligence layer feed: aircraft, vessels, military, satellites, fires, gnss. */
export function clustersIndexUrl(kind) {
  return `/api/il/${kind}/index`;
}

/**
 * @param {string} kind
 * @param {number} km
 * @param {{west:number, south:number, east:number, north:number}|null} [box]
 *   Only clusters touching this box (degrees; west > east crosses the antimeridian).
 */
export function clustersUrl(kind, km, box = null) {
  const base = `/api/il/${kind}?km=${encodeURIComponent(distanceLabel(km))}`;
  if (!box) return base;
  const edges = [box.west, box.south, box.east, box.north].map((v) => Number(v.toFixed(3)));
  return `${base}&bbox=${edges.join(',')}`;
}

/**
 * Which satellites of one relation observe the clusters of the given lanes.
 * @param {string} relation imaging | fire | weather | receivers | navigation | imaged |
 *   cameras | alpr | street | overflights
 * @param {Array<{kind: string, km: number}>} lanes
 * @param {{west:number, south:number, east:number, north:number}|null} [box]
 * @param {Array<{kind: string, km: number}>|null} [observers] Observer lanes (overflights:
 *   the aircraft distances on show).
 */
export function observationUrl(relation, lanes, box = null, observers = null) {
  const targets = lanes.map(({ kind, km }) => `${kind}:${distanceLabel(km)}`).join(',');
  const lanesOf = observers ? `&observers=${observers.map(({ kind, km }) => `${kind}:${distanceLabel(km)}`).join(',')}` : '';
  const base = `/api/il/observability/${relation}?targets=${targets}${lanesOf}`;
  if (!box) return base;
  const edges = [box.west, box.south, box.east, box.north].map((v) => Number(v.toFixed(3)));
  return `${base}&bbox=${edges.join(',')}`;
}

/** Areas of interest: where the intelligence layer computes. */
export const IL_AREAS_URL = '/api/il/areas';

/** Views wider than this are treated as worldwide (the overview). */
const MAX_VIEW_SPAN_DEG = 150;

/**
 * The part of the world to ask for, from a view rectangle in degrees: padded
 * by `pad` of its size on each side so small pans need no new request, or null
 * (worldwide) when the view is missing or nearly global.
 * @param {{west:number, south:number, east:number, north:number}|null} view
 */
export function requestBox(view, pad = 0.25) {
  if (!view || ![view.west, view.south, view.east, view.north].every(finite)) return null;
  const width = view.east >= view.west ? view.east - view.west : view.east + 360 - view.west;
  const height = view.north - view.south;
  if (width > MAX_VIEW_SPAN_DEG || height > MAX_VIEW_SPAN_DEG / 2 || height <= 0) return null;
  const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const grow = Math.min(width * (1 + 2 * pad), 359.999);
  const cx = view.west + width / 2;
  return {
    west: wrap(cx - grow / 2),
    east: wrap(cx + grow / 2),
    south: Math.max(-90, view.south - height * pad),
    north: Math.min(90, view.north + height * pad),
  };
}

/** Whether `inner` lies within `outer` (both request boxes; null = worldwide). */
export function boxCovers(outer, inner) {
  if (!outer) return true;
  if (!inner) return false;
  const span = (b) => (b.east >= b.west ? [[b.west, b.east]] : [[b.west, 180], [-180, b.east]]);
  if (inner.south < outer.south || inner.north > outer.north) return false;
  return span(inner).every(([a, b]) => span(outer).some(([c, d]) => a >= c && b <= d));
}

/**
 * The distance to show: the current choice while the intelligence layer still
 * offers it, otherwise its default, otherwise its first distance.
 */
export function pickDistance(available, current, fallback) {
  const list = (available || []).map(Number).filter((km) => Number.isFinite(km) && km > 0);
  if (!list.length) return null;
  if (list.includes(Number(current))) return Number(current);
  if (list.includes(Number(fallback))) return Number(fallback);
  return list[0];
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @typedef {object} Motion
 * @property {number} lat
 * @property {number} lon
 * @property {number} altM Height above the ellipsoid.
 * @property {number|null} speedMps Ground speed.
 * @property {number|null} trackDeg Direction of travel, clockwise from north.
 * @property {number|null} climbMps
 * @property {number|null} reportedAt Unix seconds of the position report.
 */

/**
 * An OpenSky aircraft as the IL publishes it. Height is GNSS (`geo_altitude`,
 * an ellipsoid height like the globe's) when reported, else barometric.
 * @returns {Motion}
 */
export function aircraftMotion(node) {
  return {
    lat: node?.lat,
    lon: node?.lon,
    altM: finite(node?.geo_altitude) ? node.geo_altitude : finite(node?.alt_m) ? node.alt_m : 0,
    speedMps: finite(node?.velocity) ? node.velocity : null,
    trackDeg: finite(node?.true_track) ? node.true_track : null,
    climbMps: finite(node?.vertical_rate) ? node.vertical_rate : null,
    reportedAt: finite(node?.time_position) ? node.time_position : null,
  };
}

/**
 * An AIS vessel as the IL publishes it. AIS reserves 102.3 kn and a 360°
 * course for "not available".
 * @returns {Motion}
 */
export function vesselMotion(node) {
  const speedKn = finite(node?.speed) && node.speed < 102.3 ? node.speed : null;
  const course = finite(node?.course) && node.course < 360 ? node.course : null;
  return {
    lat: node?.lat,
    lon: node?.lon,
    altM: 0,
    speedMps: speedKn === null ? null : speedKn * KNOT_MPS,
    trackDeg: course,
    climbMps: null,
    reportedAt: finite(node?.last_position_epoch) ? node.last_position_epoch : null,
  };
}

/**
 * Where a contact is now, extrapolated from its last report along its track
 * at its speed (and climb rate), for at most `maxAheadS` seconds; an older
 * report is drawn where it would be after `maxAheadS`.
 * @param {Motion} m
 * @param {number} nowSec Current Unix time in seconds.
 * @param {number} maxAheadS
 * @returns {{lat:number, lon:number, altM:number}|null}
 */
export function predictPosition(m, nowSec, maxAheadS) {
  if (!finite(m?.lat) || !finite(m?.lon)) return null;
  const alt = finite(m.altM) ? m.altM : 0;
  const reportedAt = finite(m.reportedAt) ? m.reportedAt : nowSec;
  const dt = Math.min(Math.max(nowSec - reportedAt, 0), maxAheadS);
  if (!finite(m.speedMps) || !finite(m.trackDeg) || dt === 0) {
    return { lat: m.lat, lon: m.lon, altM: alt };
  }
  const dist = m.speedMps * dt;
  const track = (m.trackDeg * Math.PI) / 180;
  const latRad = (m.lat * Math.PI) / 180;
  const dLat = (dist * Math.cos(track)) / EARTH_RADIUS_M;
  const dLon = (dist * Math.sin(track)) / (EARTH_RADIUS_M * Math.max(Math.cos(latRad), 1e-6));
  let lon = m.lon + (dLon * 180) / Math.PI;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  const climb = finite(m.climbMps) ? m.climbMps * dt : 0;
  return {
    lat: m.lat + (dLat * 180) / Math.PI,
    lon,
    altM: Math.max(alt + climb, 0),
  };
}

/**
 * A military aircraft as the IL publishes it (adsb.lol row plus metric
 * fields): geometric height, else barometric.
 * @returns {Motion}
 */
export function militaryMotion(node) {
  return {
    lat: node?.lat,
    lon: node?.lon,
    altM: finite(node?.alt_m) ? node.alt_m : 0,
    speedMps: finite(node?.speed_mps) ? node.speed_mps : null,
    trackDeg: finite(node?.track) ? node.track : null,
    climbMps: finite(node?.climb_mps) ? node.climb_mps : null,
    reportedAt: finite(node?.position_epoch) ? node.position_epoch : null,
  };
}

/**
 * Where a satellite is at `nowSec`, propagated with SGP4 from the TLE the IL
 * clustered it with (as GEV's satellites layer does). The satrec is cached on
 * the node.
 * @returns {{lat:number, lon:number, altM:number}|null}
 */
export function satellitePosition(node, nowSec) {
  if (!node?.tle_line1 || !node?.tle_line2) return null;
  try {
    node._satrec ??= twoline2satrec(node.tle_line1, node.tle_line2);
    const date = new Date(nowSec * 1000);
    const pv = propagate(node._satrec, date);
    if (!pv?.position || typeof pv.position === 'boolean') return null;
    const geo = eciToGeodetic(pv.position, gstime(date));
    return {
      lat: degreesLat(geo.latitude),
      lon: degreesLong(geo.longitude),
      altM: geo.height * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * A closed footprint outline ([[lon, lat], ...]) with extra points along long
 * edges, so straight segments between them follow the curved surface instead
 * of cutting under it. Fewer than two points gives nothing.
 * @param {Array<[number, number]>} hull
 * @param {number} [stepKm=10]
 * @returns {Array<[number, number]>}
 */
export function densifyRing(hull, stepKm = 10) {
  const pts = (hull || []).filter(
    (p) => Array.isArray(p) && finite(p[0]) && finite(p[1]),
  );
  if (pts.length < 2) return [];
  const ring = pts.length === 2 ? pts : [...pts, pts[0]];
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    let [lon2, lat2] = ring[i + 1];
    // Take the short way across the antimeridian.
    if (lon2 - lon1 > 180) lon2 -= 360;
    if (lon1 - lon2 > 180) lon2 += 360;
    const km =
      (Math.hypot(
        (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180),
        lat2 - lat1,
      ) *
        Math.PI *
        EARTH_RADIUS_M) /
      180 /
      1000;
    const steps = Math.max(1, Math.ceil(km / stepKm));
    for (let k = 0; k < steps; k++) {
      const f = k / steps;
      let lon = lon1 + (lon2 - lon1) * f;
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      out.push([lon, lat1 + (lat2 - lat1) * f]);
    }
  }
  out.push(ring[ring.length - 1]);
  return out;
}

/**
 * The camera height that frames a cluster (metres above it): from how far
 * members lie from its centre, or the size of its footprint when that is
 * larger (one GNSS cell is ~55 km wide but has a single centre).
 */
export function framingHeightM(radiusKm, areaKm2 = 0) {
  const r = Math.max(finite(radiusKm) ? radiusKm : 0, finite(areaKm2) && areaKm2 > 0 ? Math.sqrt(areaKm2) : 0);
  return Math.min(Math.max(r * 4000, 8000), 4_000_000);
}

/** A 0.5° GNSS cell as the IL publishes it, as a [lon, lat] ring of its corners. */
export function cellCorners(node) {
  const { south, west, north, east } = node || {};
  if (![south, west, north, east].every(finite)) return [];
  return [[west, south], [east, south], [east, north], [west, north]];
}

/**
 * A circle of `radiusKm` around a point on the surface, as a closed
 * [lon, lat] ring of `steps` segments.
 */
export function circleRing(lat, lon, radiusKm, steps = 72) {
  if (!finite(lat) || !finite(lon) || !finite(radiusKm) || radiusKm <= 0) return [];
  const d = (radiusKm * 1000) / EARTH_RADIUS_M;
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const brg = (2 * Math.PI * i) / steps;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(brg));
    const lo2 = lo + Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(la),
      Math.cos(d) - Math.sin(la) * Math.sin(la2),
    );
    ring.push([((((lo2 * 180) / Math.PI + 540) % 360) - 180), (la2 * 180) / Math.PI]);
  }
  return ring;
}

/** Most cluster count labels one layer hands the world overlay; larger clusters first. */
export const CLUSTER_LABEL_LIMIT = 256;

/**
 * The world-overlay label that shows how many members a cluster has, at its
 * centre and in its colour. Larger clusters win label collisions.
 * @param {{clusterId: string, count: number, title: string, position: object, color: string}} input
 *   `position` is a Cartesian3 the layer keeps updating while members move.
 */
export function clusterLabelEntry({ clusterId, count, title, position, color }) {
  return {
    id: String(clusterId),
    position,
    variant: 'label',
    title,
    accent: color,
    priority: count,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Where a satellite (`tle_line1`/`tle_line2`) is at `nowSec`, Earth-fixed (km),
 * or null when SGP4 can't place it.
 */
export function satelliteEcf(sat, nowSec) {
  if (!sat?.tle_line1 || !sat?.tle_line2) return null;
  try {
    sat._satrec ??= twoline2satrec(sat.tle_line1, sat.tle_line2);
    const date = new Date(nowSec * 1000);
    const pv = propagate(sat._satrec, date);
    if (!pv?.position || typeof pv.position === 'boolean') return null;
    return eciToEcf(pv.position, gstime(date));
  } catch {
    return null;
  }
}

/** Elevation in degrees of an Earth-fixed position (km) above a place's horizon. */
export function elevationDeg(ecf, lat, lon, heightM = 0) {
  if (!ecf) return null;
  const observer = { latitude: (lat * Math.PI) / 180, longitude: (lon * Math.PI) / 180, height: heightM / 1000 };
  return (ecfToLookAngles(observer, ecf).elevation * 180) / Math.PI;
}
