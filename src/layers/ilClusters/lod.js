// Level of detail for cluster footprints: a cluster is drawn as its polygon
// (hull) once the hull is big enough on screen, and as its glow node only
// when it would be a few pixels. Pure helpers, so the thresholds are tested.

const M_PER_DEG = 111320;

/** The hull shows once it spans this many screen pixels... */
export const LOD_SHOW_PX = 40;
/** ...and hides again only below this (hysteresis: no flicker at the edge). */
export const LOD_HIDE_PX = 28;
/** Fully opaque from this size on; it fades in between. */
export const LOD_FULL_PX = 120;

/** Distinct, finite [lon, lat] points of a hull. */
export function hullPoints(hull) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(hull) ? hull : []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([p[0], p[1]]);
  }
  return out;
}

/** The diagonal of a hull's bounding box, in metres (short way across the antimeridian). */
export function hullExtentM(points) {
  if (!points?.length) return 0;
  const lats = points.map((p) => p[1]);
  const ref = points[0][0];
  const lons = points.map(([lon]) => ref + ((((lon - ref) % 360) + 540) % 360) - 180);
  const dLat = Math.max(...lats) - Math.min(...lats);
  const mid = (Math.max(...lats) + Math.min(...lats)) / 2;
  const dLon = (Math.max(...lons) - Math.min(...lons)) * Math.cos((mid * Math.PI) / 180);
  return Math.hypot(dLat, dLon) * M_PER_DEG;
}

/**
 * Whether a cluster has a polygon worth drawing: at least three members and a
 * hull of three or more distinct points with some extent. Returns the points
 * and extent, or null.
 */
export function usableHull(hull, size) {
  if (!(size >= 3)) return null;
  const points = hullPoints(hull);
  if (points.length < 3) return null;
  const extentM = hullExtentM(points);
  return extentM > 0 ? { points, extentM } : null;
}

/** Roughly how many screen pixels `extentM` spans at `distanceM` from a perspective camera. */
export function pixelsAcross(extentM, distanceM, fovyRad, heightPx) {
  if (!(distanceM > 0) || !(fovyRad > 0)) return 0;
  return (extentM / (2 * distanceM * Math.tan(fovyRad / 2))) * heightPx;
}

/** Whether the polygon is shown, given whether it was shown last time. */
export function lodShown(px, wasShown) {
  return px >= (wasShown ? LOD_HIDE_PX : LOD_SHOW_PX);
}

/** Polygon opacity factor (0..1) by screen size. */
export function lodAlpha(px) {
  return Math.max(0, Math.min(1, (px - LOD_HIDE_PX) / (LOD_FULL_PX - LOD_HIDE_PX)));
}

/** The node's scale and opacity while its polygon is shown at `alpha`: smaller and dimmer, still clickable. */
export function markerDim(alpha) {
  const a = Math.max(0, Math.min(1, alpha || 0));
  return { scale: 1 - 0.35 * a, alpha: 1 - 0.45 * a };
}
