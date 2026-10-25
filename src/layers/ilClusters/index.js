import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { nearFarScalarValueAtDistance } from '../../data/focusDeemphasis.js';
import {
  IL_AIRCRAFT_CLUSTERS_ID,
  IL_FIRE_CLUSTERS_ID,
  IL_GNSS_ZONES_ID,
  IL_MILITARY_CLUSTERS_ID,
  IL_SATELLITE_CLUSTERS_ID,
  IL_VESSEL_CLUSTERS_ID,
  aircraftMotion,
  clusterColorCss,
  clustersIndexUrl,
  clustersUrl,
  densifyRing,
  distanceLabel,
  framingHeightM,
  militaryMotion,
  pickDistance,
  predictPosition,
  satellitePosition,
  vesselMotion,
} from './model.js';
import { describeCluster } from './describe.js';
export * from './model.js';
export { describeCluster, CLUSTER_KINDS } from './describe.js';

const REPOSITION_MS = 250;
const LINK_WIDTH = 1.5;
const FOOTPRINT_WIDTH = 2;
const FLY_SECONDS = 1.5;

/**
 * Proximity clusters computed by the local intelligence layer, drawn over the
 * GEV layer that shows the same contacts: a ring per clustered contact and
 * the shortest links that join each cluster, coloured by cluster, plus (for
 * surface feeds) each cluster's footprint outline. Rings sit where the anchor
 * layer draws each contact (its detection anchors); contacts it isn't drawing
 * are placed from the intelligence layer's report (dead reckoning, or SGP4 for
 * satellites). The link distance is chosen with the row chips; the
 * Intelligence panel lists each cluster's synthesized summary.
 *
 * @param {object} config
 * @param {string} config.id Layer id.
 * @param {string} config.name English layer name.
 * @param {string} config.icon
 * @param {string} config.source
 * @param {string} config.kind Intelligence layer feed (see CLUSTER_KINDS).
 * @param {object|null} [config.anchorLayer] GEV layer with getDetectableObjects().
 * @param {(node: object) => import('./model.js').Motion} [config.motionOf]
 * @param {(node: object, nowSec: number) => ({lat:number, lon:number, altM:number}|null)} [config.positionOf]
 *   Where a contact is now; defaults to dead reckoning `motionOf` for up to `maxDeadReckonS`.
 * @param {number} [config.maxDeadReckonS=0]
 * @param {boolean} [config.staticPositions=false] Contacts never move (fires,
 *   cells): place them once per update, on the ground.
 * @param {{fireAnchorHeight: Function, warmFireAnchorFloors: Function}|null} [config.groundAnchors]
 *   Ground heights for static contacts (the FIRMS layer's DEM anchors).
 * @param {boolean} [config.footprints=false] Draw each cluster's outline.
 * @param {(node: object) => boolean} [config.includeNode] Contacts to show (e.g.
 *   only those the anchor layer currently draws); clusters left with fewer than
 *   two shown members are dropped. Re-evaluated on every update.
 * @param {number} config.updateInterval
 * @param {number} config.ringPixels
 * @param {Cesium.NearFarScalar|null} [config.scaleByDistance] Size scaling of the
 *   anchor layer's sprites, or null when they keep a fixed screen size.
 * @param {number} [config.liftM=0] Raise rings and links this far above the
 *   contact so a surface (sea mesh, terrain) doesn't clip them.
 * @param {boolean} [config.alwaysOnTop=false] Draw rings without depth testing,
 *   like the anchor layer's surface sprites, hiding those beyond the horizon.
 * @param {(distance: string) => string} config.chipTitle
 * @param {Function} [config.fetchImpl]
 */
export function createIlClustersLayer({
  id,
  name,
  icon,
  source,
  kind,
  anchorLayer = null,
  motionOf = null,
  positionOf = null,
  maxDeadReckonS = 0,
  staticPositions = false,
  groundAnchors = null,
  footprints = false,
  includeNode = null,
  updateInterval,
  ringPixels,
  scaleByDistance = null,
  liftM = 0,
  alwaysOnTop = false,
  chipTitle,
  fetchImpl = globalThis.fetch,
}) {
  let _viewer = null;
  let _points = null;
  let _lines = null;
  let _outlines = null;
  let _request = null;
  let _timer = null;
  let _enabled = false;
  let _distances = [];
  let _distanceKm = null;
  let _nodes = [];
  let _edges = [];
  let _clusters = [];
  let _drawnPoints = new Map();
  let _drawnLines = [];
  let _staticWhere = new Map();
  let _clusterCount = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  const _clusterListeners = new Set();

  const notifyRow = () => _rowListener?.();
  const notifyClusters = () => {
    for (const listener of _clusterListeners) {
      try {
        listener();
      } catch (error) {
        console.warn(`[Data:IL] ${kind} cluster listener failed:`, error);
      }
    }
  };
  const scratchNormal = new Cesium.Cartesian3();
  const placeOf =
    positionOf ||
    ((node, nowSec) => predictPosition(motionOf?.(node), nowSec, maxDeadReckonS));

  function lifted(cart) {
    if (!liftM) return cart;
    const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cart, scratchNormal);
    return Cesium.Cartesian3.add(cart, Cesium.Cartesian3.multiplyByScalar(normal, liftM, normal), new Cesium.Cartesian3());
  }

  function groundHeight(lat, lon) {
    const h = groundAnchors?.fireAnchorHeight?.(lat, lon);
    return Number.isFinite(h) ? h : 0;
  }

  /** Contact id -> where the anchor layer is drawing that contact right now. */
  function liveAnchors() {
    const anchors = new Map();
    let objects = [];
    try {
      objects = anchorLayer?.getDetectableObjects?.() || [];
    } catch (error) {
      console.warn(`[Data:IL] ${kind} anchors unavailable:`, error);
    }
    for (const object of objects) {
      if (object?.sourceId && object.position)
        anchors.set(String(object.sourceId).toLowerCase(), object.position);
    }
    return anchors;
  }

  function placeStatic() {
    _staticWhere = new Map();
    for (const node of _nodes) {
      _staticWhere.set(node.id, Cesium.Cartesian3.fromDegrees(node.lon, node.lat, groundHeight(node.lat, node.lon) + liftM));
    }
  }

  function reposition() {
    if (!_enabled || !_points) return;
    const now = Date.now() / 1000;
    let where = _staticWhere;
    if (!staticPositions) {
      const anchors = liveAnchors();
      where = new Map();
      for (const node of _nodes) {
        const anchor = anchors.get(node.id);
        let cart;
        if (anchor) cart = lifted(Cesium.Cartesian3.clone(anchor));
        else {
          const p = placeOf(node, now);
          if (!p) continue;
          cart = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM + liftM);
        }
        where.set(node.id, cart);
      }
    }
    const occluder = alwaysOnTop && _viewer
      ? new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, _viewer.camera.positionWC)
      : null;
    for (const [nodeId, point] of _drawnPoints) {
      const cart = where.get(nodeId);
      if (!cart) {
        point.show = false;
        continue;
      }
      point.position = cart;
      point.show = occluder ? occluder.isPointVisible(cart) : true;
    }
    const height = _viewer?.camera?.positionCartographic?.height;
    const width = scaleByDistance && Number.isFinite(height)
      ? Math.max(1, LINK_WIDTH * nearFarScalarValueAtDistance(scaleByDistance, height))
      : LINK_WIDTH;
    for (const { line, a, b } of _drawnLines) {
      const pa = where.get(a);
      const pb = where.get(b);
      line.show = Boolean(pa && pb);
      if (pa && pb) line.positions = [pa, pb];
      if (line.width !== width) line.width = width;
    }
    governorRequestRender(id);
  }

  function drawFootprints(color) {
    _outlines.removeAll();
    if (!footprints) return;
    for (const cluster of _clusters) {
      const ring = densifyRing(cluster.summary?.hull);
      if (ring.length < 2) continue;
      const positions = ring.map(([lon, lat]) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, groundHeight(lat, lon) + liftM),
      );
      _outlines.add({
        positions,
        width: FOOTPRINT_WIDTH,
        material: Cesium.Material.fromType('Color', { color: color(cluster.id).withAlpha(0.85) }),
      });
    }
  }

  function rebuild() {
    _points.removeAll();
    _lines.removeAll();
    _drawnPoints = new Map();
    _drawnLines = [];
    const colorOf = new Map();
    const color = (clusterId) => {
      if (!colorOf.has(clusterId))
        colorOf.set(clusterId, Cesium.Color.fromCssColorString(clusterColorCss(clusterId)));
      return colorOf.get(clusterId);
    };
    if (staticPositions) placeStatic();
    for (const node of _nodes) {
      const c = color(node.cluster_id);
      _drawnPoints.set(node.id, _points.add({
        id: `${id}:${node.id}`,
        position: Cesium.Cartesian3.ZERO,
        pixelSize: ringPixels,
        color: c.withAlpha(0.15),
        outlineColor: c,
        outlineWidth: 2,
        show: false,
        ...(scaleByDistance ? { scaleByDistance } : {}),
        ...(alwaysOnTop ? { disableDepthTestDistance: Number.POSITIVE_INFINITY } : {}),
      }));
    }
    const clusterOf = new Map(_nodes.map((n) => [n.id, n.cluster_id]));
    for (const edge of _edges) {
      if (!clusterOf.has(edge.a) || !clusterOf.has(edge.b)) continue;
      const line = _lines.add({
        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
        width: LINK_WIDTH,
        show: false,
        material: Cesium.Material.fromType('Color', {
          color: color(clusterOf.get(edge.a)).withAlpha(0.9),
        }),
      });
      _drawnLines.push({ line, a: edge.a, b: edge.b });
    }
    drawFootprints(color);
    reposition();
  }

  /** Warm DEM heights under static contacts, then re-place them once. */
  function warmGround() {
    if (!staticPositions || !groundAnchors?.warmFireAnchorFloors) return;
    const points = _nodes.map(({ lat, lon }) => ({ lat, lon }));
    for (const c of _clusters)
      for (const [lon, lat] of c.summary?.hull || []) points.push({ lat, lon });
    const nodes = _nodes;
    groundAnchors.warmFireAnchorFloors(points).then((warmed) => {
      if (warmed && _enabled && _points && nodes === _nodes) rebuild();
    });
  }

  async function refresh() {
    if (!_enabled || !_points) return false;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    const stale = () => request.signal.aborted || _request !== request || !_enabled;
    try {
      const indexRes = await fetchImpl(clustersIndexUrl(kind), { signal: request.signal, cache: 'no-store' });
      const index = await indexRes.json();
      if (stale()) return false;
      if (!indexRes.ok) throw new Error(index?.error || `HTTP ${indexRes.status}`);
      _distances = Array.isArray(index.distances_km) ? index.distances_km : [];
      _distanceKm = pickDistance(_distances, _distanceKm, index.default_km);
      if (_distanceKm === null) throw new Error(msg('Intelligence layer offers no link distances'));

      const res = await fetchImpl(clustersUrl(kind, _distanceKm), { signal: request.signal, cache: 'no-store' });
      const body = await res.json();
      if (stale()) return false;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      let nodes = (body.nodes || [])
        .filter((n) => n.cluster_id)
        .map((n) => ({ ...n, id: String(n.id).toLowerCase() }));
      if (includeNode) {
        nodes = nodes.filter(includeNode);
        const shown = new Map();
        for (const n of nodes) shown.set(n.cluster_id, (shown.get(n.cluster_id) || 0) + 1);
        nodes = nodes.filter((n) => shown.get(n.cluster_id) >= 2);
      }
      _nodes = nodes;
      const nodeIds = new Set(_nodes.map((n) => n.id));
      const clusterIds = new Set(_nodes.map((n) => n.cluster_id));
      _edges = (body.edges || [])
        .map((e) => ({ a: String(e.a).toLowerCase(), b: String(e.b).toLowerCase() }))
        .filter((e) => nodeIds.has(e.a) && nodeIds.has(e.b));
      // Only clusters seen this tick carry a summary; ended ones are history.
      _clusters = (body.clusters || []).filter((c) => c.summary && clusterIds.has(c.id));
      _clusterCount = new Set(_nodes.map((n) => n.cluster_id)).size;
      rebuild();
      warmGround();
      _lastUpdate = Date.now();
      _lastError = null;
      const anchors = staticPositions ? new Map() : liveAnchors();
      const anchored = _nodes.filter((n) => anchors.has(n.id)).length;
      console.log(
        `[Data:IL] ${kind} ${distanceLabel(_distanceKm)} km: ${_nodes.length} clustered (${anchored} on drawn contacts), ${_clusterCount} clusters, ${_edges.length} links`,
      );
      return true;
    } catch (e) {
      if (stale()) return false;
      console.warn(`[Data:IL] ${kind} clusters unavailable:`, e);
      _lastError = e?.message || msg('Intelligence layer unavailable');
      return false;
    } finally {
      if (_request === request) _request = null;
      notifyRow();
      notifyClusters();
    }
  }

  function show(visible) {
    for (const collection of [_points, _lines, _outlines]) if (collection) collection.show = visible;
  }

  return {
    id,
    name,
    icon,
    source,
    kind,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${id} layer is already initialized`);
      _viewer = viewer;
      _points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      _lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
      _outlines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
      show(false);
    },

    enable() {
      _enabled = true;
      show(true);
      clearInterval(_timer);
      _timer = staticPositions ? setInterval(reposition, REPOSITION_MS * 4) : setInterval(reposition, REPOSITION_MS);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      clearInterval(_timer);
      _timer = null;
      show(false);
      governorRequestRender(id);
      notifyClusters();
    },

    update() {
      return refresh();
    },

    setParams(params = {}) {
      if (params.distanceKm === undefined) return true;
      const km = Number(params.distanceKm);
      if (!Number.isFinite(km) || km <= 0) return false;
      if (_distances.length && !_distances.includes(km)) return false;
      if (km === _distanceKm) return true;
      _distanceKm = km;
      notifyRow();
      if (_enabled) refresh();
      return true;
    },

    getParams() {
      return { distanceKm: _distanceKm };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      return {
        chips: _distances.map((km) => ({
          id: `distance-${distanceLabel(km)}`,
          label: t('{distance} km', { distance: formatNumber(km) }),
          active: km === _distanceKm,
          params: { distanceKm: km },
          title: chipTitle(formatNumber(km)),
        })),
        info: _lastUpdate
          ? t('{clusters} clusters · lines show the shortest links joining each cluster', {
              clusters: formatNumber(_clusterCount),
            })
          : null,
      };
    },

    /**
     * The current clusters, largest first, each with its colour and the
     * synthesized description the Intelligence panel shows. Empty while off.
     * @returns {Array<{id: string, color: string, size: number, title: string, lines: string[]}>}
     */
    getClusterSummaries() {
      if (!_enabled) return [];
      return _clusters
        .slice()
        .sort((a, b) => (b.summary.size ?? b.size) - (a.summary.size ?? a.size))
        .map((c) => ({
          id: c.id,
          color: clusterColorCss(c.id),
          size: c.summary.size ?? c.size,
          ...describeCluster(c, kind),
        }));
    },

    /** @param {() => void} listener Called whenever the cluster list changes. */
    subscribeClusters(listener) {
      if (typeof listener !== 'function') return () => {};
      _clusterListeners.add(listener);
      return () => _clusterListeners.delete(listener);
    },

    /** Fly the camera over one cluster. */
    focusCluster(clusterId) {
      const cluster = _clusters.find((c) => c.id === clusterId);
      const centre = cluster?.summary?.centroid;
      if (!_viewer || !centre) return false;
      const alt = Number.isFinite(centre.alt_m) ? centre.alt_m : 0;
      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, alt + framingHeightM(cluster.summary.radius_km)),
        duration: FLY_SECONDS,
      });
      return true;
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      clearInterval(_timer);
      _timer = null;
      _enabled = false;
      if (viewer) {
        for (const collection of [_points, _lines, _outlines])
          if (collection) viewer.scene.primitives.remove(collection);
      }
      _points = null;
      _lines = null;
      _outlines = null;
      _viewer = null;
      _nodes = [];
      _edges = [];
      _clusters = [];
      _drawnPoints = new Map();
      _drawnLines = [];
      _staticWhere = new Map();
      _clusterCount = 0;
      _lastUpdate = null;
      _lastError = null;
      _rowListener = null;
      _clusterListeners.clear();
    },

    getStats() {
      return { count: _nodes.length, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}

/** Aircraft clusters, anchored to the flights layer's planes. */
export function createIlAircraftClustersLayer({ flights = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_AIRCRAFT_CLUSTERS_ID,
    name: 'Aircraft clusters (IL)',
    icon: '🔗',
    source: 'Intelligence layer · OpenSky',
    kind: 'aircraft',
    anchorLayer: flights,
    motionOf: aircraftMotion,
    maxDeadReckonS: 120,
    updateInterval: 30000,
    ringPixels: 14,
    // The flights layer's sprite scaling, so rings grow and shrink with planes.
    scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
    chipTitle: (distance) =>
      t('Link aircraft closer than {distance} km in a straight line, height included', { distance }),
    fetchImpl,
  });
}

/** Military aircraft clusters, anchored to the military layer's planes. */
export function createIlMilitaryClustersLayer({ military = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_MILITARY_CLUSTERS_ID,
    name: 'Military clusters (IL)',
    icon: '🎖',
    source: 'Intelligence layer · adsb.lol',
    kind: 'military',
    anchorLayer: military,
    motionOf: militaryMotion,
    maxDeadReckonS: 120,
    updateInterval: 30000,
    ringPixels: 14,
    // The military layer's normal billboard scaling.
    scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
    chipTitle: (distance) =>
      t('Link military aircraft closer than {distance} km in a straight line, height included', { distance }),
    fetchImpl,
  });
}

/** Vessel clusters, anchored to the AIS vessels layer's ships. */
export function createIlVesselClustersLayer({ vessels = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_VESSEL_CLUSTERS_ID,
    name: 'Vessel clusters (IL)',
    icon: '⚓',
    source: 'Intelligence layer · AISStream',
    kind: 'vessels',
    anchorLayer: vessels,
    motionOf: vesselMotion,
    // AIS reports arrive minutes late and ships are slow; the vessels layer
    // itself refreshes once a minute.
    maxDeadReckonS: 600,
    updateInterval: 60000,
    // Ship sprites keep a fixed screen size, so the rings do too.
    ringPixels: 18,
    scaleByDistance: null,
    liftM: 30,
    alwaysOnTop: true,
    footprints: true,
    chipTitle: (distance) =>
      t('Link vessels closer than {distance} km along the surface', { distance }),
    fetchImpl,
  });
}

/** Satellite clusters, anchored to the satellites layer's points, else SGP4. */
export function createIlSatelliteClustersLayer({ satellites = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_SATELLITE_CLUSTERS_ID,
    name: 'Satellite clusters (IL)',
    icon: '🛰',
    source: 'Intelligence layer · CelesTrak',
    kind: 'satellites',
    anchorLayer: satellites,
    positionOf: satellitePosition,
    // GEV draws Starlink only with its DENSE chip on; without it those rings
    // would mark empty sky.
    includeNode: (node) => node.group !== 'starlink' || satellites?.getParams?.().catalog === 'dense',
    updateInterval: 30000,
    ringPixels: 14,
    // The satellites layer's point scaling.
    scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6),
    chipTitle: (distance) =>
      t('Link satellites closer than {distance} km in a straight line', { distance }),
    fetchImpl,
  });
}

/** Fire clusters: groups of FIRMS detections, on the ground. */
export function createIlFireClustersLayer({ surface = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_FIRE_CLUSTERS_ID,
    name: 'Fire clusters (IL)',
    icon: '🔥',
    source: 'Intelligence layer · NASA FIRMS',
    kind: 'fires',
    staticPositions: true,
    groundAnchors: surface?.anchors ?? null,
    footprints: true,
    // GEV serves FIRMS from a 30 min cache; the IL re-reads it every 10 min.
    updateInterval: 300000,
    ringPixels: 12,
    liftM: 20,
    alwaysOnTop: true,
    chipTitle: (distance) =>
      t('Link fire detections closer than {distance} km along the surface', { distance }),
    fetchImpl,
  });
}

/** Zones of low GNSS navigation accuracy: neighbouring anomaly cells. */
export function createIlGnssZonesLayer({ surface = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_GNSS_ZONES_ID,
    name: 'GNSS zones (IL)',
    icon: '📡',
    source: 'Intelligence layer · adsb.lol',
    kind: 'gnss',
    staticPositions: true,
    groundAnchors: surface?.anchors ?? null,
    footprints: true,
    updateInterval: 60000,
    ringPixels: 16,
    liftM: 50,
    alwaysOnTop: true,
    chipTitle: (distance) =>
      t('Join low-accuracy cells whose centres are closer than {distance} km', { distance }),
    fetchImpl,
  });
}
