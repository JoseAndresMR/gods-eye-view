// Pure helpers for the intelligence-layer cluster overlays (aircraft, vessels).

export const IL_AIRCRAFT_CLUSTERS_ID = 'il-aircraft-clusters';
export const IL_VESSEL_CLUSTERS_ID = 'il-vessel-clusters';

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

/** @param {'aircraft'|'vessels'} kind */
export function clustersIndexUrl(kind) {
  return `/api/il/${kind}/index`;
}

/** @param {'aircraft'|'vessels'} kind */
export function clustersUrl(kind, km) {
  return `/api/il/${kind}?km=${encodeURIComponent(distanceLabel(km))}`;
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
