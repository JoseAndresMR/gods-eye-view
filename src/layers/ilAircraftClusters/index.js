import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  IL_AIRCRAFT_CLUSTERS_ID,
  IL_AIRCRAFT_CLUSTERS_URL,
  clusterColorCss,
  predictPosition,
} from './model.js';
export * from './model.js';

const REPOSITION_MS = 1000;

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/**
 * Proximity clusters of airborne aircraft computed by the local intelligence
 * layer (within 5 NM horizontally by default): links between linked aircraft
 * and a ring per clustered aircraft, coloured by cluster and dead-reckoned
 * between polls so they follow the planes.
 */
export function createIlAircraftClustersLayer({ fetchImpl = globalThis.fetch } = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _timer = null;
  let _enabled = false;
  let _nodes = [];
  let _edges = [];
  let _ringEntities = new Map();
  let _edgeEntities = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  const toCartesian = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM);

  function clearEntities() {
    _dataSource?.entities.removeAll();
    _ringEntities = new Map();
    _edgeEntities = [];
  }

  function reposition() {
    if (!_enabled || !_dataSource) return;
    const now = Date.now() / 1000;
    const where = new Map();
    for (const node of _nodes) {
      const p = predictPosition(node, now);
      if (!p) continue;
      where.set(node.id, p);
      _ringEntities.get(node.id)?.position.setValue(toCartesian(p));
    }
    for (const { entity, a, b } of _edgeEntities) {
      const pa = where.get(a);
      const pb = where.get(b);
      if (pa && pb) entity.polyline.positions.setValue([toCartesian(pa), toCartesian(pb)]);
    }
    governorRequestRender(IL_AIRCRAFT_CLUSTERS_ID);
  }

  function rebuild() {
    _dataSource.entities.suspendEvents();
    try {
      clearEntities();
      for (const node of _nodes) {
        const color = Cesium.Color.fromCssColorString(clusterColorCss(node.cluster_id));
        const entity = _dataSource.entities.add({
          id: `${IL_AIRCRAFT_CLUSTERS_ID}:ring:${node.id}`,
          position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.ZERO),
          point: {
            pixelSize: 14,
            color: color.withAlpha(0.15),
            outlineColor: color,
            outlineWidth: 2,
          },
        });
        _ringEntities.set(node.id, entity);
      }
      const byId = new Map(_nodes.map((n) => [n.id, n]));
      for (const edge of _edges) {
        const a = byId.get(edge.a);
        if (!a || !byId.has(edge.b)) continue;
        const entity = _dataSource.entities.add({
          id: `${IL_AIRCRAFT_CLUSTERS_ID}:link:${edge.a}:${edge.b}`,
          polyline: {
            positions: new Cesium.ConstantProperty([Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO]),
            width: 2,
            arcType: Cesium.ArcType.NONE,
            material: Cesium.Color.fromCssColorString(clusterColorCss(a.cluster_id)).withAlpha(0.9),
          },
        });
        _edgeEntities.push({ entity, a: edge.a, b: edge.b });
      }
    } finally {
      _dataSource.entities.resumeEvents();
    }
    reposition();
  }

  return {
    id: IL_AIRCRAFT_CLUSTERS_ID,
    name: 'Aircraft clusters (IL)',
    icon: '🔗',
    source: 'Intelligence layer · OpenSky',
    updateInterval: 30000,

    init(viewer) {
      if (_viewer) throw new Error('IL aircraft clusters layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(IL_AIRCRAFT_CLUSTERS_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      clearInterval(_timer);
      _timer = setInterval(reposition, REPOSITION_MS);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      clearInterval(_timer);
      _timer = null;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const res = await fetchImpl(IL_AIRCRAFT_CLUSTERS_URL, { signal: request.signal, cache: 'no-store' });
        const body = await res.json();
        if (request.signal.aborted || _request !== request || !_enabled) return false;
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        _nodes = (body.nodes || []).filter((n) => n.cluster_id);
        _edges = body.edges || [];
        _count = _nodes.length;
        rebuild();
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:IL] ${_count} clustered aircraft, ${_edges.length} links`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled) return false;
        console.warn('[Data:IL] Aircraft clusters unavailable:', e);
        _lastError = e?.message || msg('Intelligence layer unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      clearInterval(_timer);
      _timer = null;
      _enabled = false;
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _nodes = [];
      _edges = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}
