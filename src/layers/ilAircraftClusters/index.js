import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  IL_AIRCRAFT_CLUSTERS_ID,
  aircraftClustersUrl,
  IL_AIRCRAFT_INDEX_URL,
  clusterColorCss,
  distanceLabel,
  pickDistance,
  predictPosition,
} from './model.js';
export * from './model.js';

const REPOSITION_MS = 1000;

/**
 * Proximity clusters of airborne aircraft computed by the local intelligence
 * layer: aircraft closer than the chosen straight-line 3D distance (height
 * included) are linked. Draws a ring per clustered aircraft and the shortest
 * links that join each cluster, coloured by cluster and dead-reckoned between
 * polls so they follow the planes. The distance is chosen with the row chips.
 */
export function createIlAircraftClustersLayer({ fetchImpl = globalThis.fetch } = {}) {
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

  const toCartesian = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM);
  const notifyRow = () => _rowListener?.();

  function reposition() {
    if (!_enabled || !_points) return;
    const now = Date.now() / 1000;
    const where = new Map();
    for (const node of _nodes) {
      const p = predictPosition(node, now);
      if (!p) continue;
      const cart = toCartesian(p);
      where.set(node.id, cart);
      const point = _drawnPoints.get(node.id);
      if (point) point.position = cart;
    }
    for (const { line, a, b } of _drawnLines) {
      const pa = where.get(a);
      const pb = where.get(b);
      if (pa && pb) line.positions = [pa, pb];
    }
    governorRequestRender(IL_AIRCRAFT_CLUSTERS_ID);
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
        id: `${IL_AIRCRAFT_CLUSTERS_ID}:${node.id}`,
        position: Cesium.Cartesian3.ZERO,
        pixelSize: 12,
        color: c.withAlpha(0.15),
        outlineColor: c,
        outlineWidth: 2,
      }));
    }
    const clusterOf = new Map(_nodes.map((n) => [n.id, n.cluster_id]));
    for (const edge of _edges) {
      if (!clusterOf.has(edge.a) || !clusterOf.has(edge.b)) continue;
      const line = _lines.add({
        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
        width: 2,
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
      const indexRes = await fetchImpl(IL_AIRCRAFT_INDEX_URL, { signal: request.signal, cache: 'no-store' });
      const index = await indexRes.json();
      if (stale()) return false;
      if (!indexRes.ok) throw new Error(index?.error || `HTTP ${indexRes.status}`);
      _distances = Array.isArray(index.distances_km) ? index.distances_km : [];
      _distanceKm = pickDistance(_distances, _distanceKm, index.default_km);
      if (_distanceKm === null) throw new Error(msg('Intelligence layer offers no link distances'));

      const res = await fetchImpl(aircraftClustersUrl(_distanceKm), { signal: request.signal, cache: 'no-store' });
      const body = await res.json();
      if (stale()) return false;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      _nodes = (body.nodes || []).filter((n) => n.cluster_id);
      _edges = body.edges || [];
      _clusterCount = new Set(_nodes.map((n) => n.cluster_id)).size;
      rebuild();
      _lastUpdate = Date.now();
      _lastError = null;
      console.log(
        `[Data:IL] ${distanceLabel(_distanceKm)} km: ${_nodes.length} clustered aircraft, ${_clusterCount} clusters, ${_edges.length} links`,
      );
      return true;
    } catch (e) {
      if (stale()) return false;
      console.warn('[Data:IL] Aircraft clusters unavailable:', e);
      _lastError = e?.message || msg('Intelligence layer unavailable');
      return false;
    } finally {
      if (_request === request) _request = null;
      notifyRow();
    }
  }

  const layer = {
    id: IL_AIRCRAFT_CLUSTERS_ID,
    name: 'Aircraft clusters (IL)',
    icon: '🔗',
    source: 'Intelligence layer · OpenSky',
    updateInterval: 30000,

    init(viewer) {
      if (_viewer) throw new Error('IL aircraft clusters layer is already initialized');
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
      governorRequestRender(IL_AIRCRAFT_CLUSTERS_ID);
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
          title: t('Link aircraft closer than {distance} km in a straight line, height included', {
            distance: formatNumber(km),
          }),
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
  return layer;
}
