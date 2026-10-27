import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { nearFarScalarValueAtDistance } from '../../data/focusDeemphasis.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
import {
  IL_AIRCRAFT_CLUSTERS_ID,
  IL_FIRE_CLUSTERS_ID,
  IL_GNSS_ZONES_ID,
  IL_EVENT_CLUSTERS_ID,
  IL_MILITARY_AREA_CLUSTERS_ID,
  IL_DATACENTER_CLUSTERS_ID,
  IL_DAM_CLUSTERS_ID,
  IL_LANDING_CLUSTERS_ID,
  IL_CAMERA_CLUSTERS_ID,
  IL_MILITARY_CLUSTERS_ID,
  IL_SATELLITE_CLUSTERS_ID,
  IL_VESSEL_CLUSTERS_ID,
  CLUSTER_LABEL_LIMIT,
  aircraftMotion,
  boxCovers,
  requestBox,
  clusterColorCss,
  clustersIndexUrl,
  clustersUrl,
  cellCorners,
  circleRing,
  clusterLabelEntry,
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
import {
  clusterPickId,
  isClusterSelected,
  select,
  subscribeSelection,
  useIlPicking,
} from './selection.js';
import { GNSS_LEVEL_COLORS } from '../gnss/records.js';
export * from './model.js';
export { describeCluster, CLUSTER_KINDS } from './describe.js';
export {
  createIlCameraObserversLayer,
  createIlFireSatellitesLayer,
  createIlImagedSatellitesLayer,
  createIlImagingSatellitesLayer,
  createIlNavigationSatellitesLayer,
  createIlReceiverSatellitesLayer,
  createIlOverflightObserversLayer,
  createIlPlateReaderObserversLayer,
  createIlStreetImageryObserversLayer,
  createIlWeatherSatellitesLayer,
} from './observation.js';

const REPOSITION_MS = 250;
const LINK_WIDTH = 1.5;
const FOOTPRINT_WIDTH = 2;
const FLY_SECONDS = 1.5;
/** Wait this long after the camera stops before asking for the new view. */
const MOVE_SETTLE_MS = 400;
/** Retry this soon after a failed read: a paused tracker needs a few seconds to wake. */
const RETRY_MS = 10000;

/**
 * Proximity clusters computed by the local intelligence layer, drawn over the
 * GEV layer that shows the same contacts. Each cluster is one graph node at
 * the centre of its members, tagged with its member count; cross-layer edges
 * end at it. Its members (a ring per contact and the shortest links joining
 * them, coloured by cluster) show for every cluster with the Members chip, or
 * for the selected cluster (click its node or its card). Surface feeds also
 * draw each cluster's footprint outline. Rings sit where the anchor layer
 * draws each contact (its detection anchors); contacts it isn't drawing are
 * placed from the intelligence layer's report (dead reckoning, or SGP4 for
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
 * @param {(node: object) => Array<[number, number]>} [config.areaOf] Contacts are
 *   areas (GNSS cells): draw each one's outline ([lon, lat] corners) in its
 *   cluster colour instead of a ring, and no links.
 * @param {(node: object) => string} [config.areaColorOf] CSS colour of one area
 *   outline (e.g. its severity) instead of its cluster colour.
 * @param {string} [config.footprintColor] CSS colour for every cluster outline
 *   and card swatch, when area colours carry the meaning instead.
 * @param {(meta: object) => Array<{ring: Array<[number, number]>, css: string, width: number}>} [config.contextOf]
 *   Extra outlines from the IL file's meta (e.g. where the feed can see, or
 *   areas with data but no cluster), drawn under the cluster outlines.
 * @param {(state: {clusters: number, meta: object}) => string} [config.infoOf]
 *   Row info text; defaults to the cluster count and link note.
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
  areaOf = null,
  areaColorOf = null,
  footprintColor = null,
  contextOf = null,
  infoOf = null,
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
  let _meta = {};
  let _box = null;
  let _idle = false;
  let _truncated = null;
  let _summaryOnly = [];
  // One node per cluster, at the centre of its placed members (or at its summary
  // centre when the feed listed it without members). Count tags and cross-layer
  // edges attach to the same positions.
  // [{clusterId, count, members: string[]|null, position: Cartesian3, point}]
  let _anchors = [];
  let _labelsShown = false;
  // Members (rings and links) of every cluster, or only of the selected one.
  let _showMembers = false;
  // Hidden: the layer stays on and computed (cross-layer edges still end at its nodes),
  // but only the selected cluster is drawn.
  let _hidden = false;
  let _selectedHere = null;
  let _releasePicking = null;
  let _unsubscribeSelection = null;
  let _removeMoveEnd = null;
  let _moveTimer = null;
  let _retryTimer = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  // Extra card lines from cross-layer relations, by relation layer id, in registration order.
  const _annotators = new Map();
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
  const labelSource = `il-clusters:${kind}`;
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
    placeAnchors(where, occluder);
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

  /**
   * Move each cluster node to the centre of its members' current places: their
   * mean direction from the Earth's centre at their mean distance, so it stays
   * at the members' height even for clusters wrapped around the globe. Nodes
   * ignore depth like the rings, so those beyond the horizon are hidden.
   */
  const drawnAnchor = (anchor) => !_hidden || isClusterSelected(id, anchor.clusterId);

  function placeAnchors(where, occluder) {
    for (const anchor of _anchors) {
      const visible = () =>
        Cesium.Cartesian3.magnitude(anchor.position) > 0 && (!occluder || occluder.isPointVisible(anchor.position));
      if (!anchor.members) {
        anchor.point.show = visible() && drawnAnchor(anchor);
        continue;
      }
      let x = 0, y = 0, z = 0, r = 0, n = 0;
      for (const nodeId of anchor.members) {
        const cart = where.get(nodeId);
        if (!cart) continue;
        x += cart.x;
        y += cart.y;
        z += cart.z;
        r += Cesium.Cartesian3.magnitude(cart);
        n++;
      }
      const len = Math.hypot(x, y, z);
      if (n && len) {
        const scale = r / n / len;
        anchor.position.x = x * scale;
        anchor.position.y = y * scale;
        anchor.position.z = z * scale;
        anchor.point.position = anchor.position;
      } // else nothing placed yet: keep the last place
      anchor.point.show = visible() && drawnAnchor(anchor);
    }
  }

  /** One node per cluster (pickable: selecting it shows its members and edges). */
  function buildAnchors(color) {
    const membersOf = new Map();
    for (const node of _nodes) {
      if (!membersOf.has(node.cluster_id)) membersOf.set(node.cluster_id, []);
      membersOf.get(node.cluster_id).push(node.id);
    }
    _anchors = [];
    for (const cluster of _clusters) {
      const members = membersOf.get(cluster.id) || null;
      const centre = cluster.summary?.centroid;
      if (!members && !centre) continue;
      // Satellites may hide some members (Starlink without DENSE): count what is shown.
      const count = members && includeNode ? members.length : cluster.summary?.size ?? cluster.size;
      let position = new Cesium.Cartesian3();
      if (!members) {
        const alt = staticPositions ? groundHeight(centre.lat, centre.lon) : Number.isFinite(centre.alt_m) ? centre.alt_m : 0;
        position = Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, alt + liftM);
      }
      const c = footprintColor ? Cesium.Color.fromCssColorString(footprintColor) : color(cluster.id);
      const selected = isClusterSelected(id, cluster.id);
      const point = _points.add({
        id: clusterPickId(id, cluster.id),
        position,
        pixelSize: ringPixels * (selected ? 2.2 : 1.6),
        color: c.withAlpha(selected ? 0.55 : 0.35),
        outlineColor: selected ? Cesium.Color.WHITE : c,
        outlineWidth: 3,
        show: false,
        ...(scaleByDistance ? { scaleByDistance } : {}),
        ...(alwaysOnTop ? { disableDepthTestDistance: Number.POSITIVE_INFINITY } : {}),
      });
      _anchors.push({ clusterId: cluster.id, count, members, position, point });
    }
  }

  /** One count tag per cluster node, largest clusters first. */
  function publishLabels() {
    const labelled = _anchors.filter(drawnAnchor).sort((a, b) => b.count - a.count).slice(0, CLUSTER_LABEL_LIMIT);
    setOverlayEntries(
      labelSource,
      labelled.map((label) => clusterLabelEntry({
        ...label,
        title: formatNumber(label.count),
        color: footprintColor || clusterColorCss(label.clusterId),
      })),
      { cohortLimit: CLUSTER_LABEL_LIMIT, moving: !staticPositions },
    );
    _labelsShown = true;
  }

  function hideLabels() {
    if (!_labelsShown) return;
    _labelsShown = false;
    clearOverlaySource(labelSource);
  }

  /** A [lon, lat] ring as a polyline on the ground. */
  function drawRing(collection, ring, color, width) {
    if (ring.length < 2) return;
    collection.add({
      positions: ring.map(([lon, lat]) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, groundHeight(lat, lon) + liftM),
      ),
      width,
      material: Cesium.Material.fromType('Color', { color }),
    });
  }

  function drawFootprints(color) {
    _outlines.removeAll();
    if (_hidden && !_selectedHere) return;
    for (const c of contextOf?.(_meta) || [])
      drawRing(_outlines, densifyRing(c.ring), Cesium.Color.fromCssColorString(c.css), c.width);
    if (!footprints) return;
    const fixed = footprintColor ? Cesium.Color.fromCssColorString(footprintColor) : null;
    for (const cluster of _clusters.filter((c) => !_hidden || c.id === _selectedHere))
      drawRing(_outlines, densifyRing(cluster.summary?.hull), (fixed || color(cluster.id)).withAlpha(0.85), FOOTPRINT_WIDTH);
  }

  function rebuild() {
    _points.removeAll();
    _lines.removeAll();
    _drawnPoints = new Map();
    _drawnLines = [];
    _anchors = [];
    const colorOf = new Map();
    const color = (clusterId) => {
      if (!colorOf.has(clusterId))
        colorOf.set(clusterId, Cesium.Color.fromCssColorString(clusterColorCss(clusterId)));
      return colorOf.get(clusterId);
    };
    if (staticPositions) placeStatic();
    const shown = _nodes.filter((n) => (_showMembers && !_hidden) || n.cluster_id === _selectedHere);
    if (areaOf) {
      for (const node of shown) {
        const css = areaColorOf?.(node);
        drawRing(_lines, densifyRing(areaOf(node)), css ? Cesium.Color.fromCssColorString(css) : color(node.cluster_id), FOOTPRINT_WIDTH);
      }
    }
    for (const node of areaOf ? [] : shown) {
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
    const clusterOf = new Map((areaOf ? [] : shown).map((n) => [n.id, n.cluster_id]));
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
    buildAnchors(color);
    drawFootprints(color);
    publishLabels();
    reposition();
  }

  /** Rebuild when the selection enters, leaves or moves within this layer. */
  function onSelection(selection) {
    const here = selection?.type === 'cluster' && selection.layerId === id ? selection.clusterId : null;
    if (here === _selectedHere) return;
    _selectedHere = here;
    if (_enabled && _points) rebuild();
    notifyClusters();
  }

  /** The view rectangle in degrees, or null when the camera sees no ground. */
  function viewRect() {
    const r = _viewer?.camera?.computeViewRectangle?.();
    if (!r) return null;
    const deg = Cesium.Math.toDegrees;
    return { west: deg(r.west), south: deg(r.south), east: deg(r.east), north: deg(r.north) };
  }

  /** After the camera settles, fetch again if the view left what was fetched. */
  function onMoveEnd() {
    clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      if (!_enabled || _idle) return;
      const next = requestBox(viewRect());
      const partial = _truncated && (_truncated.listed < _truncated.of || _truncated.drawn < _truncated.listed);
      if (!boxCovers(_box, next) || (partial && JSON.stringify(next) !== JSON.stringify(_box))) refresh();
    }, MOVE_SETTLE_MS);
  }

  /** Warm DEM heights under static contacts, then re-place them once. */
  function warmGround() {
    if (!staticPositions || !groundAnchors?.warmFireAnchorFloors) return;
    const points = _nodes.map(({ lat, lon }) => ({ lat, lon }));
    for (const c of _clusters)
      for (const [lon, lat] of densifyRing(c.summary?.hull)) points.push({ lat, lon });
    if (areaOf)
      for (const n of _nodes)
        for (const [lon, lat] of densifyRing(areaOf(n))) points.push({ lat, lon });
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
      _idle = Boolean(index.idle);
      if (_idle) {
        // No area of interest is enabled: the IL computes nothing.
        _nodes = [];
        _edges = [];
        _clusters = [];
        _summaryOnly = [];
        _clusterCount = 0;
        _truncated = null;
        rebuild();
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      }

      const box = requestBox(viewRect());
      const res = await fetchImpl(clustersUrl(kind, _distanceKm, box), { signal: request.signal, cache: 'no-store' });
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
      // A tiled feed may list clusters without their members (`drawn` false).
      _clusters = (body.clusters || []).filter((c) => c.summary && (clusterIds.has(c.id) || c.drawn === false));
      _summaryOnly = _clusters.filter((c) => c.drawn === false);
      _clusterCount = _clusters.length;
      _truncated = body.truncated || null;
      _box = box;
      _meta = body.meta || {};
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
      clearTimeout(_retryTimer);
      _retryTimer = setTimeout(() => _enabled && refresh(), RETRY_MS);
      return false;
    } finally {
      if (_request === request) _request = null;
      notifyRow();
      notifyClusters();
    }
  }

  function show(visible) {
    for (const collection of [_points, _lines, _outlines]) if (collection) collection.show = visible;
    setOverlaySourceVisible(labelSource, visible);
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
      _releasePicking?.();
      _releasePicking = useIlPicking(_viewer);
      _unsubscribeSelection?.();
      _unsubscribeSelection = subscribeSelection(onSelection);
      _removeMoveEnd?.();
      _removeMoveEnd = _viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd) || null;
      clearInterval(_timer);
      _timer = staticPositions ? setInterval(reposition, REPOSITION_MS * 4) : setInterval(reposition, REPOSITION_MS);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _unsubscribeSelection?.();
      _unsubscribeSelection = null;
      if (_selectedHere) select(null);
      _selectedHere = null;
      _releasePicking?.();
      _releasePicking = null;
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      clearTimeout(_moveTimer);
      clearTimeout(_retryTimer);
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
      if (params.members !== undefined && Boolean(params.members) !== _showMembers) {
        _showMembers = Boolean(params.members);
        notifyRow();
        if (_enabled && _points) rebuild();
      }
      if (params.hidden !== undefined && Boolean(params.hidden) !== _hidden) {
        _hidden = Boolean(params.hidden);
        notifyRow();
        if (_enabled && _points) rebuild();
      }
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
      return { distanceKm: _distanceKm, members: _showMembers, hidden: _hidden };
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
        })).concat({
          id: 'members',
          label: t('Members'),
          active: _showMembers,
          params: { members: !_showMembers },
          title: t('Show every member of every cluster; otherwise one node per cluster, and the members of the selected one'),
        }).concat({
          id: 'hidden',
          label: t('Hide'),
          active: _hidden,
          params: { hidden: !_hidden },
          title: t('Stop drawing this layer\'s clusters. It stays on and computed, so cross-layer edges still end at its nodes; a selected cluster is still drawn'),
        }),
        info: !_lastUpdate
          ? null
          : _idle
            ? t('Paused · no area of interest is enabled')
            : _truncated && (_truncated.listed < _truncated.of || _truncated.drawn < _truncated.listed)
              ? t('{listed} largest of {total} clusters here · large rings are whole clusters, zoom in for their members', {
                  listed: formatNumber(_truncated.listed),
                  total: formatNumber(_truncated.of),
                })
              : infoOf
            ? infoOf({ clusters: _clusterCount, meta: _meta })
            : t('{clusters} clusters · lines show the shortest links joining each cluster', {
                clusters: formatNumber(_clusterCount),
              }),
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
        .map((c) => {
          const card = describeCluster(c, kind);
          const extra = [];
          for (const annotate of _annotators.values()) {
            try {
              extra.push(...(annotate(c, _distanceKm) || []));
            } catch (error) {
              console.warn(`[Data:IL] ${kind} card annotation failed:`, error);
            }
          }
          return {
            id: c.id,
            color: footprintColor || clusterColorCss(c.id),
            size: c.summary.size ?? c.size,
            selected: isClusterSelected(id, c.id),
            ...card,
            // After the first line, so a collapsed card still shows them.
            lines: [...card.lines.slice(0, 1), ...extra, ...card.lines.slice(1)],
          };
        });
    },

    isEnabled() {
      return _enabled;
    },

    /**
     * @param {string} source Relation layer id.
     * @param {((cluster: object, km: number) => string[])|null} annotator
     *   Extra card lines per cluster (as the IL lists it); null removes them.
     */
    setAnnotator(source, annotator) {
      if (typeof annotator === 'function') _annotators.set(source, annotator);
      else _annotators.delete(source);
      notifyClusters();
    },

    /** Re-render the cards (e.g. after the annotator's data changed). */
    refreshCards() {
      notifyClusters();
    },

    /** @param {() => void} listener Called whenever the cluster list changes. */
    subscribeClusters(listener) {
      if (typeof listener !== 'function') return () => {};
      _clusterListeners.add(listener);
      return () => _clusterListeners.delete(listener);
    },

    /** Where a cluster's node is drawn now (cross-layer edges end there), or null. */
    clusterNodePosition(clusterId) {
      const anchor = _anchors.find((a) => a.clusterId === clusterId);
      return anchor && Cesium.Cartesian3.magnitude(anchor.position) > 0 ? anchor.position : null;
    },

    /** Select one cluster and fly the camera over it. */
    focusCluster(clusterId) {
      const cluster = _clusters.find((c) => c.id === clusterId);
      const centre = cluster?.summary?.centroid;
      if (!_viewer || !centre) return false;
      select({ type: 'cluster', layerId: id, clusterId });
      const alt = Number.isFinite(centre.alt_m) ? centre.alt_m : 0;
      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, alt + framingHeightM(cluster.summary.radius_km, cluster.summary.area_km2)),
        duration: FLY_SECONDS,
      });
      return true;
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      clearTimeout(_moveTimer);
      clearTimeout(_retryTimer);
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
      _anchors = [];
      _unsubscribeSelection?.();
      _unsubscribeSelection = null;
      _releasePicking?.();
      _releasePicking = null;
      hideLabels();
      setOverlaySourceVisible(labelSource, false);
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
    name: 'Aircraft clusters',
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
    name: 'Military aircraft clusters',
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
    name: 'Vessel clusters',
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
    name: 'Satellite clusters',
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
    name: 'Fire clusters',
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

/** Conflict and unrest event clusters: GDELT events, a lone event being a cluster of one. */
export function createIlEventClustersLayer({ surface = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_EVENT_CLUSTERS_ID,
    name: 'Event clusters',
    icon: '✸',
    source: 'Intelligence layer · GDELT',
    kind: 'events',
    staticPositions: true,
    groundAnchors: surface?.anchors ?? null,
    footprints: true,
    // GEV refreshes its free GDELT feed every 15 min; the IL re-reads it as often.
    updateInterval: 300000,
    ringPixels: 12,
    liftM: 20,
    alwaysOnTop: true,
    chipTitle: (distance) =>
      t('Link conflict events closer than {distance} km along the surface', { distance }),
    fetchImpl,
  });
}

/** Zones of low GNSS navigation accuracy: neighbouring anomaly cells. */
export function createIlGnssZonesLayer({ surface = null, fetchImpl } = {}) {
  return createIlClustersLayer({
    id: IL_GNSS_ZONES_ID,
    name: 'GNSS zones',
    icon: '📡',
    source: 'Intelligence layer · adsb.lol',
    kind: 'gnss',
    staticPositions: true,
    groundAnchors: surface?.anchors ?? null,
    footprints: true,
    // Cells are areas: outline each like GEV's GNSS tiles, and show which
    // regions the IL watches (GEV's own layer only sees around the view).
    areaOf: cellCorners,
    // Severity in GEV's own GNSS colours (amber medium, red high); the zone
    // outline only groups cells, in a neutral colour.
    areaColorOf: (node) => GNSS_LEVEL_COLORS[node.level],
    footprintColor: '#e8feff',
    contextOf: (meta) => [
      // Cells with enough traffic and normal accuracy, so "no zone" reads as
      // "checked, fine" where there is data and as "no data" elsewhere.
      ...(meta.cells || [])
        .filter((cell) => cell.level === 'low')
        .map((cell) => ({ ring: cellCorners(cell), css: GNSS_LEVEL_COLORS.low, width: 1 })),
      // Worldwide mode watches a few fixed regions; areas show their own box.
      ...(meta.worldwide
        ? (meta.anchors || []).map(([lat, lon]) => ({
            ring: circleRing(lat, lon, (meta.radius_nm || 250) * 1.852),
            css: '#9a9a94',
            width: 1,
          }))
        : []),
    ],
    infoOf: ({ clusters, meta }) => {
      const base = meta.worldwide
        ? t('{clusters} zones · grey circles are the {regions} regions the intelligence layer watches', {
            clusters: formatNumber(clusters),
            regions: formatNumber((meta.anchors || []).length),
          })
        : t('{clusters} zones · {cells} cells with traffic, green ones normal · elsewhere no data yet', {
            clusters: formatNumber(clusters),
            cells: formatNumber((meta.cells || []).length),
          });
      return meta.cooling_down_s > 0
        ? `${base} · ${t('adsb.lol rate limit: sampling resumes in {seconds} s', { seconds: formatNumber(meta.cooling_down_s) })}`
        : base;
    },
    updateInterval: 60000,
    ringPixels: 16,
    // Cells are tens of km wide and viewed from far up; lift the outlines
    // clear of the sea surface and terrain that otherwise break them up.
    liftM: 1500,
    alwaysOnTop: true,
    chipTitle: (distance) =>
      t('Join low-accuracy cells whose centres are closer than {distance} km', { distance }),
    fetchImpl,
  });
}

/**
 * Clusters of fixed sites (they never move): placed once on the DEM ground,
 * with each cluster's outline. The IL recomputes them only when the data or
 * the areas of interest change, so GEV re-reads every 5 min.
 */
function createIlFixedClustersLayer({ id, name, icon, source, kind, chipTitle, surface = null, fetchImpl }) {
  return createIlClustersLayer({
    id,
    name,
    icon,
    source,
    kind,
    staticPositions: true,
    groundAnchors: surface?.anchors ?? null,
    footprints: true,
    updateInterval: 300000,
    ringPixels: 12,
    liftM: 20,
    alwaysOnTop: true,
    chipTitle,
    fetchImpl,
  });
}

/** Groups of named military areas (bases, airfields, ranges, training areas). */
export function createIlMilitaryAreaClustersLayer({ surface = null, fetchImpl } = {}) {
  return createIlFixedClustersLayer({
    id: IL_MILITARY_AREA_CLUSTERS_ID,
    name: 'Military area clusters',
    icon: '🪖',
    source: 'Intelligence layer · OpenStreetMap',
    kind: 'military-areas',
    chipTitle: (distance) => t('Link military areas closer than {distance} km', { distance }),
    surface,
    fetchImpl,
  });
}

/** Data centre campuses and hubs. */
export function createIlDatacenterClustersLayer({ surface = null, fetchImpl } = {}) {
  return createIlFixedClustersLayer({
    id: IL_DATACENTER_CLUSTERS_ID,
    name: 'Data centre clusters',
    icon: '🖥',
    source: 'Intelligence layer · OpenStreetMap',
    kind: 'datacenters',
    chipTitle: (distance) => t('Link data centres closer than {distance} km', { distance }),
    surface,
    fetchImpl,
  });
}

/** Dams close together, e.g. a cascade along one river. */
export function createIlDamClustersLayer({ surface = null, fetchImpl } = {}) {
  return createIlFixedClustersLayer({
    id: IL_DAM_CLUSTERS_ID,
    name: 'Dam clusters',
    icon: '🌊',
    source: 'Intelligence layer · Open Infrastructure Map',
    kind: 'dams',
    chipTitle: (distance) => t('Link dams closer than {distance} km', { distance }),
    surface,
    fetchImpl,
  });
}

/** Submarine cable landing hubs. */
export function createIlLandingClustersLayer({ surface = null, fetchImpl } = {}) {
  return createIlFixedClustersLayer({
    id: IL_LANDING_CLUSTERS_ID,
    name: 'Cable landing clusters',
    icon: '🔌',
    source: 'Intelligence layer · TeleGeography',
    kind: 'landings',
    chipTitle: (distance) => t('Link cable landings closer than {distance} km', { distance }),
    surface,
    fetchImpl,
  });
}

/** Public traffic cameras of GEV's CCTV catalog, grouped into corridors. */
export function createIlCameraClustersLayer({ surface = null, fetchImpl } = {}) {
  return createIlFixedClustersLayer({
    id: IL_CAMERA_CLUSTERS_ID,
    name: 'Camera clusters',
    icon: '📷',
    source: 'Intelligence layer · GEV CCTV catalog',
    kind: 'cameras',
    chipTitle: (distance) => t('Link cameras closer than {distance} km', { distance }),
    surface,
    fetchImpl,
  });
}
