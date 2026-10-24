// Pure helpers for the intelligence-layer aircraft clusters overlay.

export const IL_AIRCRAFT_CLUSTERS_ID = 'il-aircraft-clusters';
export const IL_AIRCRAFT_CLUSTERS_URL = '/api/il/aircraft';

/** Never extrapolate further than this; an older report is drawn where it was. */
export const MAX_DEAD_RECKON_S = 120;

const EARTH_RADIUS_M = 6371008.8;

export const CLUSTER_PALETTE = Object.freeze([
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#9a6324', '#469990', '#808000', '#000075', '#bfef45',
]);

/** Stable colour per tracked cluster id ("C12"), matching the IL's own pages. */
export function clusterColorCss(clusterId) {
  const n = Number.parseInt(String(clusterId || '').slice(1), 10);
  return Number.isFinite(n) ? CLUSTER_PALETTE[n % CLUSTER_PALETTE.length] : '#9a9a94';
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Where an aircraft is now, extrapolated from its last OpenSky report along
 * its ground track at its ground speed and vertical rate.
 * @param {object} node IL node: lat, lon, alt_m, velocity (m/s), true_track (deg), vertical_rate (m/s), time_position (s).
 * @param {number} nowSec Current Unix time in seconds.
 * @returns {{lat:number, lon:number, altM:number}|null}
 */
export function predictPosition(node, nowSec) {
  if (!finite(node?.lat) || !finite(node?.lon)) return null;
  const alt = finite(node.alt_m) ? node.alt_m : 0;
  const reportedAt = finite(node.time_position) ? node.time_position : nowSec;
  const dt = Math.min(Math.max(nowSec - reportedAt, 0), MAX_DEAD_RECKON_S);
  if (!finite(node.velocity) || !finite(node.true_track) || dt === 0) {
    return { lat: node.lat, lon: node.lon, altM: alt };
  }
  const dist = node.velocity * dt;
  const track = (node.true_track * Math.PI) / 180;
  const latRad = (node.lat * Math.PI) / 180;
  const dLat = (dist * Math.cos(track)) / EARTH_RADIUS_M;
  const dLon = (dist * Math.sin(track)) / (EARTH_RADIUS_M * Math.max(Math.cos(latRad), 1e-6));
  let lon = node.lon + (dLon * 180) / Math.PI;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  const climb = finite(node.vertical_rate) ? node.vertical_rate * dt : 0;
  return {
    lat: node.lat + (dLat * 180) / Math.PI,
    lon,
    altM: Math.max(alt + climb, 0),
  };
}
