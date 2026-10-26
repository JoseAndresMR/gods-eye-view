import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
import {
  IL_OBS_ALPR_ID,
  IL_OBS_CAMERAS_ID,
  IL_OBS_OVERFLIGHTS_ID,
  IL_OBS_STREET_ID,
  IL_SAT_FIRE_ID,
  IL_SAT_IMAGED_ID,
  IL_SAT_IMAGING_ID,
  IL_SAT_NAVIGATION_ID,
  IL_SAT_RECEIVERS_ID,
  IL_SAT_WEATHER_ID,
  boxCovers,
  clusterLabelEntry,
  distanceLabel,
  elevationDeg,
  observationUrl,
  requestBox,
  satelliteEcf,
  satellitePosition,
} from './model.js';
import {
  getSelection,
  isSatelliteSelected,
  satellitePickId,
  select,
  subscribeSelection,
  useIlPicking,
} from './selection.js';
import {
  ago,
  describeCameras,
  describeFireSatellites,
  describeOverflights,
  describePlateReaders,
  describeStreetImagery,
  describeImaged,
  describeImaging,
  describeNavigation,
  describeReceivers,
  describeWeather,
} from './describe.js';

/** Narrow-kind satellites are re-checked this often (they cross a footprint in minutes). */
const TICK_MS = 1000;
/** Above this many edges on screen, they are redrawn this often instead of every tick. */
const BUSY_EDGES = 1500;
const BUSY_REDRAW_MS = 5000;
/** Cards re-render at least this often so "in N min" counts down. */
const CARD_REFRESH_MS = 30000;
const MOVE_SETTLE_MS = 400;
const RETRY_MS = 10000;
/** Edge, dot and tag colour per observed kind. */
const KIND_CSS = Object.freeze({
  optical: '#ffd166',
  radar: '#c792ea',
  fire: '#ff7b54',
  weather: '#7fd6ff',
  ais: '#4dd0c8',
  adsb: '#9ecbff',
  sar: '#ff5c8a',
  gps: '#8bd450',
  galileo: '#5b8cff',
  glonass: '#ff6b6b',
  sentinel2: '#a3e635',
  landsat: '#34d399',
});
/** Satellite names win label collisions against cluster counts. */
const TAG_PRIORITY = 1e9;
const LINE_WIDTH = 1.5;
/** Lines end this far above the ground when the cluster node isn't drawn. */
const GROUND_LIFT_M = 20;
/**
 * A place belongs to a cluster only if it is the cluster's centre (the IL
 * snaps centres to 0.05°): it guards against a cluster that changed between
 * the cluster feed and the observability feed. Moving clusters drift between
 * the two computations, so they get more room.
 */
const SAME_PLACE_DEG = Object.freeze({ aircraft: 1, military: 1, vessels: 0.3 });
const SAME_PLACE_DEFAULT_DEG = 0.06;

/**
 * One cross-layer relation of the intelligence-layer graph: edges from
 * observers to the cluster nodes of other IL layers they observe, from the
 * IL's observability feed. Observers are satellites of a family (imaging,
 * fire, weather, receivers, navigation, recent images), placed from their
 * TLEs, or ground and air observers (public cameras, plate readers, street
 * imagery drives, aircraft clusters), placed where they stand or, for an
 * aircraft cluster whose layer is on, at that cluster's node. Every edge can
 * be drawn:
 *  - with nothing selected, the edges of the kinds whose chip is on;
 *  - a selected cluster shows all its edges, a selected satellite all of its
 *    clusters (click a node, a satellite or a card; Escape clears).
 * Edges of `lineKinds` (narrow sensors) are re-checked every second from the
 * TLEs and each satellite's elevation window, so they follow the pass; the
 * others come from the feed's last computation (each minute). Every card of
 * the target layers that are on gains the relation's lines.
 *
 * @param {object} config
 * @param {string} config.id
 * @param {string} config.name English layer name.
 * @param {string} config.icon
 * @param {string} config.relation IL relation name.
 * @param {object[]} config.targets Cluster layers (kind, isEnabled, getParams,
 *   setAnnotator, refreshCards, subscribeClusters, clusterNodePosition).
 * @param {Array<{kind: string, label: string, on: boolean}>} config.edgeKinds
 *   Observed kinds with a chip each (label is a msg() key); `on` is the default.
 * @param {string[]} [config.lineKinds] Kinds re-checked live (narrow sensors).
 * @param {(o: object) => string[]} config.describe Card lines for one cluster.
 * @param {string} config.offHint Row text while no target layer is on.
 * @param {(o: {rows: Array<{kind: string, place: object}>, overhead: number, meta: object}) => string} config.infoOf
 *   Row summary over the clusters in and around the view (the cards list only the largest).
 * @param {(value: number, meta: object) => number} [config.edgeTime] For past observations: the
 *   time (Unix s) an edge refers to, from its feed value; the edge then ends where the satellite
 *   was at that time (a faint marker) instead of where it is now.
 * @param {(o: {count: number, sat: object}) => string} [config.satelliteLine] What a selected
 *   observer's card says about the clusters it is linked to (default: observed now).
 * @param {string} [config.source]
 * @param {Object<string, object>} [config.observerLayers] Layers whose cluster nodes are
 *   observers (aircraft clusters), by layer id.
 * @param {() => Array<{kind: string, km: number}>} [config.observerLanes] The observer lanes
 *   to ask for (the aircraft distances on show).
 * @param {boolean} [config.tagAll=true] Name every observer drawn; false names only the
 *   selection's (numerous observers such as cameras).
 * @param {string} [config.selectedHeading] msg() key heading a selected observer's card.
 * @param {object|null} [config.surface] GEV surface (DEM anchors for line ends).
 * @param {Function} [config.fetchImpl]
 */
export function createIlSatelliteRelationLayer({
  id,
  name,
  icon,
  relation,
  targets = [],
  edgeKinds = [],
  lineKinds = [],
  describe,
  offHint,
  infoOf,
  edgeTime = null,
  satelliteLine = ({ count, sat }) =>
    t('Observes {count} clusters in view now · from {low}° to {high}° elevation', {
      count: formatNumber(count),
      low: formatNumber(sat.elev_min, { maximumFractionDigits: 1 }),
      high: formatNumber(sat.elev_max, { maximumFractionDigits: 1 }),
    }),
  source = 'Intelligence layer · CelesTrak',
  observerLayers = {},
  observerLanes = null,
  tagAll = true,
  selectedHeading = msg('Selected satellite'),
  surface = null,
  fetchImpl = globalThis.fetch,
}) {
  const groundAnchors = surface?.anchors ?? null;
  const tagSource = `${id}:tags`;
  const edgeOn = new Set(edgeKinds.filter((k) => k.on).map((k) => k.kind));
  let _viewer = null;
  let _points = null;
  let _lines = null;
  let _enabled = false;
  let _doc = null;
  let _lanes = [];
  let _box = null;
  let _request = null;
  let _timer = null;
  let _cardTimer = null;
  let _moveTimer = null;
  let _retryTimer = null;
  let _removeMoveEnd = null;
  let _unsubscribers = [];
  let _releasePicking = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  // `${kind}|${km}|${clusterId}` -> narrow-kind satellites observing it now: [{name, kinds}].
  let _overhead = new Map();
  let _overheadKey = '';
  let _drawnAt = 0;
  let _drawnEdges = 0;
  let _forceDraw = true;
  // Satellite marker key (`satId`, or `satId@time` for a past position) -> Cartesian3,
  // moved in place each draw so the name tags follow it.
  let _satCarts = new Map();
  let _taggedKey = '';

  const notifyRow = () => _rowListener?.();
  const laneKey = (kind, km, clusterId) => `${kind}|${km}|${clusterId}`;
  const isLive = (sat) => (sat?.kinds || []).some((k) => lineKinds.includes(k));

  function groundHeight(lat, lon) {
    const h = groundAnchors?.fireAnchorHeight?.(lat, lon);
    return Number.isFinite(h) ? h : 0;
  }

  /** Target layers that are on, with their current distance. */
  function currentLanes() {
    return targets
      .filter((layer) => layer.isEnabled?.())
      .map((layer) => ({ layer, kind: layer.kind, km: layer.getParams?.().distanceKm }))
      .filter((lane) => Number.isFinite(lane.km));
  }

  const lanesSignature = (lanes) => lanes.map(({ kind, km }) => `${kind}:${distanceLabel(km)}`).join(',');

  /** Each lane's places: [{layer, kind, km, clusterId, place}]. */
  function placesInView() {
    const out = [];
    for (const { layer, kind, km } of _lanes) {
      const lane = _doc?.targets?.[kind]?.[distanceLabel(km)] || {};
      for (const [clusterId, place] of Object.entries(lane)) out.push({ layer, kind, km, clusterId, place });
    }
    return out;
  }

  function refreshCards() {
    for (const { layer } of _lanes) layer.refreshCards?.();
  }

  /** Is this edge drawn now: the selection's edges, else those of the kinds switched on. */
  function wanted(selection, layer, clusterId, satId, sat) {
    // A selected cluster: its edges as a target, and as an observer (an aircraft cluster).
    if (selection?.type === 'cluster')
      return (selection.layerId === layer.id && selection.clusterId === clusterId)
        || (sat?.layer === selection.layerId && sat?.cluster === selection.clusterId);
    if (selection?.type === 'satellite') return selection.satId === satId;
    return (sat?.kinds || []).some((k) => edgeOn.has(k));
  }

  /**
   * Re-check the narrow-kind satellites over every cluster (cards and counts
   * use them) and draw the wanted edges; busy views redraw less often.
   */
  function tick() {
    if (!_enabled || !_doc || !_points) return;
    const nowSec = Date.now() / 1000;
    const sats = _doc.satellites || {};
    const ecf = new Map();
    const where = (satId) => {
      if (!ecf.has(satId)) ecf.set(satId, satelliteEcf(sats[satId], nowSec));
      return ecf.get(satId);
    };
    const selection = getSelection();
    const overhead = new Map();
    const edges = [];
    for (const { layer, kind, km, clusterId, place } of placesInView()) {
      // Narrow kinds: observing at the last computation, or due next; keep those inside their window now.
      const candidates = new Set(place.now.map(([satId]) => satId).filter((satId) => isLive(sats[satId])));
      for (const next of Object.values(place.next || {})) if (isLive(sats[next.sat])) candidates.add(next.sat);
      const seen = [];
      for (const satId of candidates) {
        const sat = sats[satId];
        const elev = elevationDeg(where(satId), place.lat, place.lon);
        if (elev === null || elev < sat.elev_min || elev > sat.elev_max) continue;
        seen.push({ name: sat.name, kinds: sat.kinds });
        if (wanted(selection, layer, clusterId, satId, sat)) edges.push({ satId, layer, clusterId, place, at: null });
      }
      if (seen.length) overhead.set(laneKey(kind, distanceLabel(km), clusterId), seen.sort((a, b) => a.name.localeCompare(b.name)));
      // Wide kinds: the feed's edges as computed.
      for (const [satId, value] of place.now) {
        const sat = sats[satId];
        if (!isLive(sat) && wanted(selection, layer, clusterId, satId, sat))
          edges.push({ satId, layer, clusterId, place, at: edgeTime ? edgeTime(value, _doc.meta || {}) : null });
      }
    }
    _overhead = overhead;
    const busy = edges.length > BUSY_EDGES || _drawnEdges > BUSY_EDGES;
    if (_forceDraw || !busy || Date.now() - _drawnAt >= BUSY_REDRAW_MS) draw(edges, nowSec, selection);
    const key = [...overhead].map(([k, v]) => `${k}=${v.map((s) => s.name).join('+')}`).join(';');
    if (key !== _overheadKey) {
      _overheadKey = key;
      refreshCards();
      notifyRow();
    }
  }

  const markerKey = (satId, at) => (at ? `${satId}@${Math.round(at)}` : String(satId));

  /**
   * Where an observer is drawn: from its TLE (satellites), at its cluster's node
   * (an aircraft cluster whose layer is on; it then has no marker of its own),
   * or where it stands. Returns a Cartesian3 and whether this layer marks it.
   */
  function observerPlace(sat, at, nowSec) {
    if (sat?.tle_line1) {
      const p = satellitePosition(sat, at ?? nowSec);
      return p ? { cart: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM), own: true } : null;
    }
    const layer = sat?.layer ? observerLayers[sat.layer] : null;
    if (layer?.isEnabled?.()) {
      const node = layer.clusterNodePosition?.(sat.cluster);
      if (node) return { cart: node, own: false };
    }
    if (!Number.isFinite(sat?.lat) || !Number.isFinite(sat?.lon)) return null;
    const alt = Number.isFinite(sat.alt_m) && sat.alt_m > 0 ? sat.alt_m : groundHeight(sat.lat, sat.lon) + GROUND_LIFT_M;
    return { cart: Cesium.Cartesian3.fromDegrees(sat.lon, sat.lat, alt), own: true };
  }

  /** Name tags for the satellite markers drawn now; republished only when that set changes. */
  function tag(markers) {
    const key = markers.map((m) => m.key).join(',');
    if (key === _taggedKey) return;
    _taggedKey = key;
    if (!markers.length) {
      clearOverlaySource(tagSource);
      return;
    }
    const nowSec = Date.now() / 1000;
    setOverlayEntries(
      tagSource,
      markers.map(({ key: markerId, satId, at }) => clusterLabelEntry({
        clusterId: `sat:${markerId}`,
        count: TAG_PRIORITY,
        title: at ? `${_doc.satellites[satId].name} · ${ago(nowSec - at)}` : _doc.satellites[satId].name,
        position: _satCarts.get(markerId),
        color: cssOf(_doc.satellites[satId]),
      })),
      { moving: true },
    );
  }

  function cssOf(sat) {
    const kind = (sat?.kinds || []).find((k) => KIND_CSS[k]);
    return KIND_CSS[kind] || KIND_CSS.optical;
  }

  function draw(edges, nowSec, selection) {
    _forceDraw = false;
    _drawnAt = Date.now();
    _drawnEdges = edges.length;
    _points.removeAll();
    _lines.removeAll();
    const satCart = new Map();
    const markers = new Map();
    for (const { satId, at } of edges) markers.set(markerKey(satId, at), { key: markerKey(satId, at), satId, at });
    // A selected satellite of this relation is drawn even when it observes nothing in view.
    if (selection?.type === 'satellite' && _doc.satellites?.[selection.satId] && !edgeTime)
      markers.set(markerKey(selection.satId, null), { key: markerKey(selection.satId, null), satId: selection.satId, at: null });
    for (const { key, satId, at } of markers.values()) {
      const sat = _doc.satellites[satId];
      const placed = observerPlace(sat, at, nowSec);
      if (!placed) {
        satCart.set(key, null);
        continue;
      }
      const cart = Cesium.Cartesian3.clone(placed.cart, _satCarts.get(key) || new Cesium.Cartesian3());
      _satCarts.set(key, cart);
      satCart.set(key, cart);
      if (!placed.own) continue; // drawn by its own layer (an aircraft cluster node)
      const selected = isSatelliteSelected(satId);
      // A past position is a fainter, smaller marker of the same satellite node.
      _points.add({
        id: satellitePickId(satId),
        position: cart,
        pixelSize: (selected ? 12 : 8) * (at ? 0.75 : 1),
        color: Cesium.Color.fromCssColorString(cssOf(sat)).withAlpha(at ? 0.55 : 0.9),
        outlineColor: selected ? Cesium.Color.WHITE : Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: selected ? 2 : 1,
      });
    }
    for (const { satId, layer, clusterId, place, at } of edges) {
      const from = satCart.get(markerKey(satId, at));
      if (!from) continue;
      const to = layer.clusterNodePosition?.(clusterId)
        || Cesium.Cartesian3.fromDegrees(place.lon, place.lat, groundHeight(place.lat, place.lon) + GROUND_LIFT_M);
      _lines.add({
        positions: [from, to],
        width: LINE_WIDTH,
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.fromCssColorString(cssOf(_doc.satellites[satId])).withAlpha(0.7),
        }),
      });
    }
    for (const key of _satCarts.keys()) if (!satCart.get(key)) _satCarts.delete(key);
    // Past positions are many (one per scene): tag them only for the selection's edges.
    tag([...markers.values()]
      .filter((m) => _satCarts.has(m.key) && ((!m.at && tagAll) || selection))
      .sort((a, b) => a.key.localeCompare(b.key)));
    governorRequestRender(id);
  }

  /** Card lines for one cluster of one target layer. */
  function annotate(kind, cluster, km) {
    if (!_enabled || !_doc) return [];
    const clusterId = cluster?.id;
    const place = _doc.targets?.[kind]?.[distanceLabel(km)]?.[clusterId];
    const centre = cluster?.summary?.centroid;
    if (!place || !centre) return [];
    const room = SAME_PLACE_DEG[kind] ?? SAME_PLACE_DEFAULT_DEG;
    const dLon = Math.abs(((place.lon - centre.lon + 540) % 360) - 180);
    if (Math.abs(place.lat - centre.lat) > room || dLon > room) return [];
    return describe({
      kind,
      place,
      satellites: _doc.satellites || {},
      overhead: _overhead.get(laneKey(kind, distanceLabel(km), clusterId)) || [],
      horizonS: _doc.meta?.horizon_s || 0,
      nowSec: Date.now() / 1000,
    });
  }

  function viewRect() {
    const r = _viewer?.camera?.computeViewRectangle?.();
    if (!r) return null;
    const deg = Cesium.Math.toDegrees;
    return { west: deg(r.west), south: deg(r.south), east: deg(r.east), north: deg(r.north) };
  }

  function clear() {
    _doc = null;
    _overhead = new Map();
    _overheadKey = '';
    _drawnEdges = 0;
    _points?.removeAll();
    _lines?.removeAll();
    _satCarts = new Map();
    _taggedKey = '';
    clearOverlaySource(tagSource);
    governorRequestRender(id);
  }

  async function refresh() {
    if (!_enabled || !_points) return false;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    const stale = () => request.signal.aborted || _request !== request || !_enabled;
    _lanes = currentLanes();
    try {
      if (!_lanes.length) {
        clear();
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      }
      const box = requestBox(viewRect());
      const url = observationUrl(relation, _lanes, box, observerLanes?.() || null);
      const res = await fetchImpl(url, { signal: request.signal, cache: 'no-store' });
      const body = await res.json();
      if (stale()) return false;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      // Satellite relations list `satellites`, ground and air ones `observers`.
      _doc = { ...body, satellites: body.observers || body.satellites || {} };
      _box = box;
      _overheadKey = null; // the next tick re-renders the cards
      _forceDraw = true;
      _lastUpdate = Date.now();
      _lastError = null;
      tick();
      console.log(`[Data:IL] ${relation} observation ${lanesSignature(_lanes)}: ${placesInView().length} clusters, ${Object.keys(_doc.satellites).length} observers, ${_drawnEdges} edges drawn`);
      return true;
    } catch (e) {
      if (stale()) return false;
      console.warn(`[Data:IL] ${relation} observation unavailable:`, e);
      _lastError = e?.message || msg('Intelligence layer unavailable');
      clearTimeout(_retryTimer);
      _retryTimer = setTimeout(() => _enabled && refresh(), RETRY_MS);
      return false;
    } finally {
      if (_request === request) _request = null;
      notifyRow();
    }
  }

  /** A target layer changed (on/off, distance, new clusters): refetch if the lanes did. */
  function onTargetsChanged() {
    if (!_enabled) return;
    if (lanesSignature(currentLanes()) !== lanesSignature(_lanes)) refresh();
  }

  function onSelection() {
    if (!_enabled) return;
    _forceDraw = true;
    tick();
  }

  function onMoveEnd() {
    clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      if (_enabled && _lanes.length && !boxCovers(_box, requestBox(viewRect()))) refresh();
    }, MOVE_SETTLE_MS);
  }

  function show(visible) {
    for (const collection of [_points, _lines]) if (collection) collection.show = visible;
    setOverlaySourceVisible(tagSource, visible);
  }

  return {
    id,
    name,
    icon,
    source,
    kind: `observability-${relation}`,
    updateInterval: 30000,

    init(viewer) {
      if (_viewer) throw new Error(`${id} layer is already initialized`);
      _viewer = viewer;
      _points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      _lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
      show(false);
    },

    enable() {
      _enabled = true;
      show(true);
      _releasePicking?.();
      _releasePicking = useIlPicking(_viewer);
      for (const layer of targets) layer.setAnnotator?.(id, (cluster, km) => annotate(layer.kind, cluster, km));
      _unsubscribers = [
        ...targets.map((layer) => layer.subscribeClusters?.(onTargetsChanged) || (() => {})),
        subscribeSelection(onSelection),
      ];
      _removeMoveEnd?.();
      _removeMoveEnd = _viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd) || null;
      clearInterval(_timer);
      _timer = setInterval(tick, TICK_MS);
      clearInterval(_cardTimer);
      _cardTimer = setInterval(refreshCards, CARD_REFRESH_MS);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      for (const unsubscribe of _unsubscribers) unsubscribe();
      _unsubscribers = [];
      for (const layer of targets) layer.setAnnotator?.(id, null);
      if (getSelection()?.type === 'satellite' && _doc?.satellites?.[getSelection().satId]) select(null);
      _releasePicking?.();
      _releasePicking = null;
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      clearTimeout(_moveTimer);
      clearTimeout(_retryTimer);
      clearInterval(_timer);
      clearInterval(_cardTimer);
      _timer = null;
      _cardTimer = null;
      clear();
      show(false);
    },

    update() {
      return refresh();
    },

    setParams(params = {}) {
      if (params.edgeKind === undefined) return true;
      if (!edgeKinds.some((k) => k.kind === params.edgeKind)) return false;
      if (params.on) edgeOn.add(params.edgeKind);
      else edgeOn.delete(params.edgeKind);
      _forceDraw = true;
      notifyRow();
      if (_enabled) tick();
      return true;
    },

    getParams() {
      return { edgeKinds: [...edgeOn] };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      let info = null;
      if (_lastUpdate && !_lanes.length) info = offHint();
      else if (_lastUpdate && _doc?.meta?.idle) info = t('Paused · no area of interest is enabled');
      else if (_lastUpdate && _doc) info = infoOf({ rows: placesInView(), overhead: _overhead.size, meta: _doc.meta || {} });
      return {
        chips: edgeKinds.map(({ kind, label }) => ({
          id: `edges-${kind}`,
          label: t(label),
          active: edgeOn.has(kind),
          params: { edgeKind: kind, on: !edgeOn.has(kind) },
          title: t('Draw every {kind} edge; a selected cluster or satellite always shows all of its edges', { kind: t(label) }),
        })),
        info,
      };
    },

    /**
     * What this relation knows about one satellite, for the selection card:
     * its sensor family and the clusters in view it observes now.
     * @returns {{name: string, lines: string[]}|null}
     */
    describeSatellite(satId) {
      const sat = _enabled ? _doc?.satellites?.[satId] : null;
      if (!sat) return null;
      let observing = 0;
      for (const { kind, km, clusterId, place } of placesInView()) {
        if (isLive(sat)) {
          if ((_overhead.get(laneKey(kind, distanceLabel(km), clusterId)) || []).some((s) => s.name === sat.name)) observing++;
        } else if (place.now.some(([s]) => s === satId)) observing++;
      }
      return {
        name: sat.name,
        heading: t(selectedHeading),
        lines: [sat.family, satelliteLine({ count: observing, sat, meta: _doc.meta || {} })],
      };
    },

    destroy(viewer = _viewer) {
      if (_enabled) this.disable();
      if (viewer) for (const collection of [_points, _lines]) if (collection) viewer.scene.primitives.remove(collection);
      _points = null;
      _lines = null;
      _viewer = null;
      _rowListener = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return { count: _lanes.length ? placesInView().length : 0, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}

/** Optical and radar Earth observation over fixed sites, fires and vessels. */
export function createIlImagingSatellitesLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_SAT_IMAGING_ID,
    name: 'Imaging satellites',
    icon: '👁',
    relation: 'imaging',
    targets,
    edgeKinds: [
      { kind: 'optical', label: msg('Optical'), on: true },
      { kind: 'radar', label: msg('Radar'), on: true },
    ],
    lineKinds: ['optical', 'radar'],
    describe: describeImaging,
    offHint: () => t('Switch on military area, data centre, dam, cable landing, fire, event or vessel clusters'),
    infoOf: ({ rows, overhead }) =>
      t('{overhead} of {count} clusters around the view have an imaging satellite overhead now (amber optical, violet radar) · each card below gives the next passes', {
        overhead: formatNumber(overhead),
        count: formatNumber(rows.length),
      }),
    surface,
    fetchImpl,
  });
}

/** The satellites NASA FIRMS reads, over fire clusters. */
export function createIlFireSatellitesLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_SAT_FIRE_ID,
    name: 'Fire-detecting satellites',
    icon: '♨',
    relation: 'fire',
    targets,
    edgeKinds: [{ kind: 'fire', label: msg('Fire'), on: true }],
    lineKinds: ['fire'],
    describe: describeFireSatellites,
    offHint: () => t('Switch on fire clusters'),
    infoOf: ({ rows, overhead }) =>
      t('{overhead} of {count} fire clusters around the view are under a FIRMS satellite now (orange lines) · each card below gives the next overpass', {
        overhead: formatNumber(overhead),
        count: formatNumber(rows.length),
      }),
    surface,
    fetchImpl,
  });
}

/** Geostationary and polar weather imagers over fixed sites and fires. */
export function createIlWeatherSatellitesLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_SAT_WEATHER_ID,
    name: 'Weather satellites',
    icon: '☁',
    relation: 'weather',
    targets,
    edgeKinds: [{ kind: 'weather', label: msg('Weather'), on: false }],
    describe: describeWeather,
    offHint: () => t('Switch on military area, data centre, dam, cable landing, fire or event clusters'),
    infoOf: ({ rows }) => {
      const counts = rows.map(({ place }) => place.counts?.weather || 0);
      return t('{min}–{max} weather satellites in view of each of the {count} clusters around the view · each card below names the highest', {
        min: formatNumber(counts.length ? Math.min(...counts) : 0),
        max: formatNumber(counts.length ? Math.max(...counts) : 0),
        count: formatNumber(rows.length),
      });
    },
    surface,
    fetchImpl,
  });
}

/** Space AIS, ADS-B and distress-beacon receivers over vessel and aircraft clusters. */
export function createIlReceiverSatellitesLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_SAT_RECEIVERS_ID,
    name: 'Space AIS / ADS-B receivers',
    icon: '📶',
    relation: 'receivers',
    targets,
    edgeKinds: [
      { kind: 'ais', label: msg('AIS'), on: false },
      { kind: 'adsb', label: msg('ADS-B'), on: false },
      { kind: 'sar', label: msg('Search and rescue'), on: false },
    ],
    describe: describeReceivers,
    offHint: () => t('Switch on vessel, aircraft or military aircraft clusters'),
    infoOf: ({ rows }) => {
      const reached = rows.filter(({ kind, place }) => place.counts?.[kind === 'vessels' ? 'ais' : 'adsb'] > 0).length;
      return t('{reached} of {count} clusters around the view have a space AIS / ADS-B receiver in reach now · each card below gives how many, or when the next comes', {
        reached: formatNumber(reached),
        count: formatNumber(rows.length),
      });
    },
    surface,
    fetchImpl,
  });
}

/** GPS, Galileo and GLONASS geometry over GNSS zones. */
export function createIlNavigationSatellitesLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_SAT_NAVIGATION_ID,
    name: 'Navigation geometry',
    icon: '🧭',
    relation: 'navigation',
    targets,
    edgeKinds: [
      { kind: 'gps', label: msg('GPS'), on: false },
      { kind: 'galileo', label: msg('Galileo'), on: false },
      { kind: 'glonass', label: msg('GLONASS'), on: false },
    ],
    describe: describeNavigation,
    offHint: () => t('Switch on GNSS zones'),
    infoOf: ({ rows }) => {
      const pdops = rows.map(({ place }) => place.pdop).filter(Number.isFinite);
      return pdops.length
        ? t('PDOP {best}–{worst} over the {count} zones around the view (lower is better) · each card below gives the satellites in view', {
            best: formatNumber(Math.min(...pdops), { maximumFractionDigits: 1 }),
            worst: formatNumber(Math.max(...pdops), { maximumFractionDigits: 1 }),
            count: formatNumber(rows.length),
          })
        : t('{count} zones around the view · each card below gives the satellites in view', { count: formatNumber(rows.length) });
    },
    surface,
    fetchImpl,
  });
}

/** Landsat and Sentinel-2 scenes that actually covered fixed sites and fires (NASA HLS). */
export function createIlImagedSatellitesLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_SAT_IMAGED_ID,
    name: 'Recent images',
    icon: '🖼',
    relation: 'imaged',
    targets,
    edgeKinds: [
      { kind: 'sentinel2', label: msg('Sentinel-2'), on: true },
      { kind: 'landsat', label: msg('Landsat'), on: true },
    ],
    describe: describeImaged,
    // Each edge is a scene: it ends where the satellite was when it took the image.
    edgeTime: (hoursAgo, meta) => (meta.t || Date.now() / 1000) - hoursAgo * 3600,
    offHint: () => t('Switch on military area, data centre, dam, cable landing, fire or event clusters'),
    infoOf: ({ rows }) => {
      const checked = rows.filter(({ place }) => !place.pending);
      return t('{imaged} of {count} clusters around the view were imaged in the last days, {clear} with a clear image · {pending} still being checked · each card below gives the latest', {
        imaged: formatNumber(checked.filter(({ place }) => place.now.length).length),
        count: formatNumber(rows.length),
        clear: formatNumber(checked.filter(({ place }) => place.latest_clear).length),
        pending: formatNumber(rows.length - checked.length),
      });
    },
    satelliteLine: ({ count, meta }) =>
      t('Imaged {count} clusters in view in the last {days} days', {
        count: formatNumber(count),
        days: formatNumber(meta.window_days || 0),
      }),
    surface,
    fetchImpl,
  });
}

/** How many of the clusters around the view have at least one edge of this relation. */
const reached = (rows) => formatNumber(rows.filter(({ place }) => place.now.length).length);
const fixedSitesHint = () => t('Switch on military area, data centre, dam or cable landing clusters');

/** Public traffic cameras whose view reaches into a site (GEV's CCTV catalog). */
export function createIlCameraObserversLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_OBS_CAMERAS_ID,
    name: 'Public cameras',
    icon: '📹',
    relation: 'cameras',
    source: 'Intelligence layer · GEV CCTV catalog',
    targets,
    edgeKinds: [{ kind: 'camera', label: msg('Cameras'), on: true }],
    describe: describeCameras,
    tagAll: false,
    selectedHeading: msg('Selected camera'),
    offHint: fixedSitesHint,
    infoOf: ({ rows }) =>
      t('{reached} of {count} sites around the view are watched by a public camera', {
        reached: reached(rows), count: formatNumber(rows.length),
      }),
    satelliteLine: ({ count, sat }) =>
      t('Its view reaches {count} clusters in view · {range} m, {fov}° wide', {
        count: formatNumber(count), range: formatNumber(sat.range_m), fov: formatNumber(sat.fov_deg),
      }),
    surface,
    fetchImpl,
  });
}

/** Licence-plate readers next to a site (OpenStreetMap, via DeFlock's tiles). */
export function createIlPlateReaderObserversLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_OBS_ALPR_ID,
    name: 'Plate readers',
    icon: '🚘',
    relation: 'alpr',
    source: 'Intelligence layer · DeFlock (OpenStreetMap)',
    targets,
    edgeKinds: [{ kind: 'alpr', label: msg('Plate readers'), on: true }],
    describe: describePlateReaders,
    tagAll: false,
    selectedHeading: msg('Selected plate reader'),
    offHint: fixedSitesHint,
    infoOf: ({ rows, meta }) =>
      t('{reached} of {count} sites around the view have a plate reader within 100 m · {waiting} map tiles still to check (US and Canada only)', {
        reached: reached(rows), count: formatNumber(rows.length), waiting: formatNumber(meta.tiles_waiting || 0),
      }),
    satelliteLine: ({ count }) => t('Within 100 m of {count} clusters in view', { count: formatNumber(count) }),
    surface,
    fetchImpl,
  });
}

/** Street-level imagery drives passing a site (Mapillary). */
export function createIlStreetImageryObserversLayer({ targets, surface, fetchImpl } = {}) {
  return createIlSatelliteRelationLayer({
    id: IL_OBS_STREET_ID,
    name: 'Street imagery',
    icon: '🛣',
    relation: 'street',
    source: 'Intelligence layer · Mapillary',
    targets,
    edgeKinds: [{ kind: 'street', label: msg('Capture drives'), on: true }],
    describe: describeStreetImagery,
    tagAll: false,
    selectedHeading: msg('Selected capture drive'),
    offHint: fixedSitesHint,
    infoOf: ({ rows, meta }) =>
      t('{reached} of {count} sites around the view were passed by a street-imagery drive · {waiting} map tiles still to check', {
        reached: reached(rows), count: formatNumber(rows.length), waiting: formatNumber(meta.tiles_waiting || 0),
      }),
    satelliteLine: ({ count }) => t('Passed {count} clusters in view', { count: formatNumber(count) }),
    surface,
    fetchImpl,
  });
}

/** Aircraft and military-aircraft clusters flying low over sites, ship clusters and fires. */
export function createIlOverflightObserversLayer({ targets, aircraft, military, surface, fetchImpl } = {}) {
  const laneOf = (layer, kind) => ({ kind, km: layer?.getParams?.().distanceKm ?? 20 });
  return createIlSatelliteRelationLayer({
    id: IL_OBS_OVERFLIGHTS_ID,
    name: 'Overflights',
    icon: '✈',
    relation: 'overflights',
    source: 'Intelligence layer · OpenSky / adsb.lol',
    targets,
    edgeKinds: [
      { kind: 'aircraft', label: msg('Aircraft'), on: true },
      { kind: 'military', label: msg('Military aircraft'), on: true },
    ],
    describe: describeOverflights,
    observerLayers: Object.fromEntries([aircraft, military].filter(Boolean).map((layer) => [layer.id, layer])),
    observerLanes: () => [laneOf(aircraft, 'aircraft'), laneOf(military, 'military')],
    selectedHeading: msg('Selected aircraft cluster'),
    offHint: () => t('Switch on military area, data centre, dam, cable landing, vessel or fire clusters'),
    infoOf: ({ rows }) =>
      t('{reached} of {count} clusters around the view are overflown below 3,000 m now', {
        reached: reached(rows), count: formatNumber(rows.length),
      }),
    satelliteLine: ({ count }) => t('Overflies {count} clusters in view below 3,000 m', { count: formatNumber(count) }),
    surface,
    fetchImpl,
  });
}
