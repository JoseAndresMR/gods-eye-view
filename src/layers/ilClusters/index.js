import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { nearFarScalarValueAtDistance } from '../../data/focusDeemphasis.js';
import {
  IL_AIRCRAFT_CLUSTERS_ID,
  IL_VESSEL_CLUSTERS_ID,
  aircraftMotion,
  clusterColorCss,
  clustersIndexUrl,
  clustersUrl,
  distanceLabel,
  pickDistance,
  predictPosition,
  vesselMotion,
} from './model.js';
export * from './model.js';

const REPOSITION_MS = 250;
const LINK_WIDTH = 1.5;

/**
 * Proximity clusters computed by the local intelligence layer, drawn over the
 * GEV layer that shows the same contacts: a ring per clustered contact and
 * the shortest links that join each cluster, coloured by cluster. Rings sit
 * where the anchor layer draws each contact (its detection anchors); contacts
 * it isn't drawing are dead-reckoned from the intelligence layer's report. The
 * link distance is chosen with the row chips.
 *
 * @param {object} config
 * @param {string} config.id Layer id.
 * @param {string} config.name English layer name.
 * @param {string} config.icon
 * @param {string} config.source
 * @param {'aircraft'|'vessels'} config.kind Intelligence layer feed.
 * @param {object|null} config.anchorLayer GEV layer with getDetectableObjects().
 * @param {(node: object) => import('./model.js').Motion} config.motionOf
 * @param {number} config.maxDeadReckonS
 * @param {number} config.updateInterval
 * @param {number} config.ringPixels
 * @param {Cesium.NearFarScalar|null} config.scaleByDistance Size scaling of the
 *   anchor layer's sprites, or null when they keep a fixed screen size.
 * @param {number} [config.liftM=0] Raise rings and links this far above the
 *   contact so a surface (sea mesh) doesn't clip them.
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
  motionOf,
  maxDeadReckonS,
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
  let _request = null;
  let _timer = null;
  let _enabled = false;
  let _distances = [];
  let _distanceKm = null;
  let _nodes = [];
  let _edges = [];
  let _drawnPoints = new Map();
  let _drawnLines = [];
  let _clusterCount = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;

  const notifyRow = () => _rowListener?.();
  const scratchNormal = new Cesium.Cartesian3();

  function lifted(cart) {
    if (!liftM) return cart;
    const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cart, scratchNormal);
    return Cesium.Cartesian3.add(cart, Cesium.Cartesian3.multiplyByScalar(normal, liftM, normal), new Cesium.Cartesian3());
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

  function reposition() {
    if (!_enabled || !_points) return;
    const now = Date.now() / 1000;
    const anchors = liveAnchors();
    const where = new Map();
    const occluder = alwaysOnTop && _viewer
      ? new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, _viewer.camera.positionWC)
      : null;
    for (const node of _nodes) {
      const anchor = anchors.get(node.id);
      let cart;
      if (anchor) cart = lifted(Cesium.Cartesian3.clone(anchor));
      else {
        const p = predictPosition(motionOf(node), now, maxDeadReckonS);
        if (!p) continue;
        cart = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM + liftM);
      }
      where.set(node.id, cart);
      const point = _drawnPoints.get(node.id);
      if (point) {
        point.position = cart;
        if (occluder) point.show = occluder.isPointVisible(cart);
      }
    }
    const height = _viewer?.camera?.positionCartographic?.height;
    const width = scaleByDistance && Number.isFinite(height)
      ? Math.max(1, LINK_WIDTH * nearFarScalarValueAtDistance(scaleByDistance, height))
      : LINK_WIDTH;
    for (const { line, a, b } of _drawnLines) {
      const pa = where.get(a);
      const pb = where.get(b);
      if (pa && pb) line.positions = [pa, pb];
      if (line.width !== width) line.width = width;
    }
    governorRequestRender(id);
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
    for (const node of _nodes) {
      const c = color(node.cluster_id);
      _drawnPoints.set(node.id, _points.add({
        id: `${id}:${node.id}`,
        position: Cesium.Cartesian3.ZERO,
        pixelSize: ringPixels,
        color: c.withAlpha(0.15),
        outlineColor: c,
        outlineWidth: 2,
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
        material: Cesium.Material.fromType('Color', {
          color: color(clusterOf.get(edge.a)).withAlpha(0.9),
        }),
      });
      _drawnLines.push({ line, a: edge.a, b: edge.b });
    }
    reposition();
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
      _nodes = (body.nodes || [])
        .filter((n) => n.cluster_id)
        .map((n) => ({ ...n, id: String(n.id).toLowerCase() }));
      _edges = (body.edges || []).map((e) => ({ a: String(e.a).toLowerCase(), b: String(e.b).toLowerCase() }));
      _clusterCount = new Set(_nodes.map((n) => n.cluster_id)).size;
      rebuild();
      _lastUpdate = Date.now();
      _lastError = null;
      const anchors = liveAnchors();
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
    }
  }

  return {
    id,
    name,
    icon,
    source,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${id} layer is already initialized`);
      _viewer = viewer;
      _points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      _lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
      _points.show = false;
      _lines.show = false;
    },

    enable() {
      _enabled = true;
      if (_points) _points.show = true;
      if (_lines) _lines.show = true;
      clearInterval(_timer);
      _timer = setInterval(reposition, REPOSITION_MS);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      clearInterval(_timer);
      _timer = null;
      if (_points) _points.show = false;
      if (_lines) _lines.show = false;
      governorRequestRender(id);
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

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      clearInterval(_timer);
      _timer = null;
      _enabled = false;
      if (viewer) {
        if (_points) viewer.scene.primitives.remove(_points);
        if (_lines) viewer.scene.primitives.remove(_lines);
      }
      _points = null;
      _lines = null;
      _viewer = null;
      _nodes = [];
      _edges = [];
      _drawnPoints = new Map();
      _drawnLines = [];
      _clusterCount = 0;
      _lastUpdate = null;
      _lastError = null;
      _rowListener = null;
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
    chipTitle: (distance) =>
      t('Link vessels closer than {distance} km along the surface', { distance }),
    fetchImpl,
  });
}
