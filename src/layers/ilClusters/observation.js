import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
import {
  IL_SAT_FIRE_ID,
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
  describeFireSatellites,
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
 * One cross-layer relation of the intelligence-layer graph: edges from the
 * satellites of a family (imaging, fire, weather, receivers, navigation) to
 * the cluster nodes of other IL layers they observe, from the IL's
 * observability feed. Every edge can be drawn:
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
 * @param {(o: {rows: Array<{kind: string, place: object}>, overhead: number}) => string} config.infoOf
 *   Row summary over the clusters in and around the view (the cards list only the largest).
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
  // satId -> Cartesian3 moved in place each draw, so the name tags follow it.
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
    if (selection?.type === 'cluster') return selection.layerId === layer.id && selection.clusterId === clusterId;
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
        if (wanted(selection, layer, clusterId, satId, sat)) edges.push({ satId, layer, clusterId, place });
      }
      if (seen.length) overhead.set(laneKey(kind, distanceLabel(km), clusterId), seen.sort((a, b) => a.name.localeCompare(b.name)));
      // Wide kinds: the feed's edges as computed.
      for (const [satId] of place.now) {
        const sat = sats[satId];
        if (!isLive(sat) && wanted(selection, layer, clusterId, satId, sat)) edges.push({ satId, layer, clusterId, place });
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

  /** Name tags for the satellites drawn now; republished only when that set changes. */
  function tag(satIds) {
    const key = satIds.join(',');
    if (key === _taggedKey) return;
    _taggedKey = key;
    if (!satIds.length) {
      clearOverlaySource(tagSource);
      return;
    }
    setOverlayEntries(
      tagSource,
      satIds.map((satId) => clusterLabelEntry({
        clusterId: `sat:${satId}`,
        count: TAG_PRIORITY,
        title: _doc.satellites[satId].name,
        position: _satCarts.get(satId),
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
    const satIds = new Set(edges.map((e) => e.satId));
    // A selected satellite of this relation is drawn even when it observes nothing in view.
    if (selection?.type === 'satellite' && _doc.satellites?.[selection.satId]) satIds.add(selection.satId);
    for (const satId of satIds) {
      const sat = _doc.satellites[satId];
      const p = satellitePosition(sat, nowSec);
      if (!p) {
        satCart.set(satId, null);
        continue;
      }
      const cart = _satCarts.get(satId) || new Cesium.Cartesian3();
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM, Cesium.Ellipsoid.WGS84, cart);
      _satCarts.set(satId, cart);
      satCart.set(satId, cart);
      const selected = isSatelliteSelected(satId);
      _points.add({
        id: satellitePickId(satId),
        position: cart,
        pixelSize: selected ? 12 : 8,
        color: Cesium.Color.fromCssColorString(cssOf(sat)).withAlpha(0.9),
        outlineColor: selected ? Cesium.Color.WHITE : Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: selected ? 2 : 1,
      });
    }
    for (const { satId, layer, clusterId, place } of edges) {
      const from = satCart.get(satId);
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
    for (const satId of _satCarts.keys()) if (!satCart.get(satId)) _satCarts.delete(satId);
    tag([..._satCarts.keys()].sort());
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
      const res = await fetchImpl(observationUrl(relation, _lanes, box), { signal: request.signal, cache: 'no-store' });
      const body = await res.json();
      if (stale()) return false;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      _doc = body;
      _box = box;
      _overheadKey = null; // the next tick re-renders the cards
      _forceDraw = true;
      _lastUpdate = Date.now();
      _lastError = null;
      tick();
      console.log(`[Data:IL] ${relation} observation ${lanesSignature(_lanes)}: ${placesInView().length} clusters, ${Object.keys(body.satellites || {}).length} satellites, ${_drawnEdges} edges drawn`);
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
    source: 'Intelligence layer · CelesTrak',
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
      else if (_lastUpdate && _doc) info = infoOf({ rows: placesInView(), overhead: _overhead.size });
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
        lines: [
          sat.family,
          t('Observes {count} clusters in view now · from {low}° to {high}° elevation', {
            count: formatNumber(observing),
            low: formatNumber(sat.elev_min, { maximumFractionDigits: 1 }),
            high: formatNumber(sat.elev_max, { maximumFractionDigits: 1 }),
          }),
        ],
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
    offHint: () => t('Switch on military area, data centre, dam, cable landing, fire or vessel clusters'),
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
    offHint: () => t('Switch on military area, data centre, dam, cable landing or fire clusters'),
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
