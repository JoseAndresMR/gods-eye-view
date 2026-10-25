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
  describeFireSatellites,
  describeImaging,
  describeNavigation,
  describeReceivers,
  describeWeather,
} from './describe.js';

/** Satellites drawn with lines are re-checked this often (they cross a footprint in minutes). */
const TICK_MS = 1000;
/** Cards re-render at least this often so "in N min" counts down. */
const CARD_REFRESH_MS = 30000;
const MOVE_SETTLE_MS = 400;
const RETRY_MS = 10000;
/** Line and dot colour per observed kind. */
const KIND_CSS = Object.freeze({ optical: '#ffd166', radar: '#c792ea', fire: '#ff7b54' });
/** Satellite names win label collisions against cluster counts. */
const TAG_PRIORITY = 1e9;
const LINE_WIDTH = 1.5;
/** Lines end this far above the ground so terrain doesn't swallow them. */
const GROUND_LIFT_M = 20;
/**
 * A place belongs to a cluster only if it is the cluster's centre (the IL
 * snaps centres to 0.05°): cluster ids restart when a tracker resumes, so an
 * id alone may name another cluster until the observability feed catches up.
 * Moving clusters drift between the two computations, so they get more room.
 */
const SAME_PLACE_DEG = Object.freeze({ aircraft: 1, military: 1, vessels: 0.3 });
const SAME_PLACE_DEFAULT_DEG = 0.06;

/**
 * Which satellites observe the clusters of other IL layers: one cross-layer
 * relation of the intelligence layer's observability feed (imaging, fire,
 * weather, receivers, navigation). Every card of the target layers that are
 * on gains the relation's lines. For relations with `lineKinds`, satellites of
 * those kinds observing a cluster right now are drawn, named, with a line to
 * each cluster (re-checked every second from their TLEs and their elevation
 * windows, so lines follow the pass).
 *
 * @param {object} config
 * @param {string} config.id
 * @param {string} config.name English layer name.
 * @param {string} config.icon
 * @param {string} config.relation IL relation name.
 * @param {object[]} config.targets Cluster layers (kind, isEnabled, getParams,
 *   setAnnotator, refreshCards, subscribeClusters).
 * @param {string[]} [config.lineKinds] Observed kinds drawn live.
 * @param {(o: object) => string[]} config.describe Card lines for one cluster.
 * @param {string} config.offHint Row text while no target layer is on.
 * @param {(o: {places: number, overhead: number}) => string} config.infoOf
 * @param {object|null} [config.surface] GEV surface (DEM anchors for line ends).
 * @param {Function} [config.fetchImpl]
 */
export function createIlSatelliteRelationLayer({
  id,
  name,
  icon,
  relation,
  targets = [],
  lineKinds = [],
  describe,
  offHint,
  infoOf,
  surface = null,
  fetchImpl = globalThis.fetch,
}) {
  const groundAnchors = surface?.anchors ?? null;
  const tagSource = `${id}:tags`;
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
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  // `${kind}|${km}|${clusterId}` -> satellites of lineKinds observing it now: [{name, kinds}].
  let _overhead = new Map();
  let _drawnKey = '';
  // satId -> Cartesian3 moved in place each tick, so the name tags follow it.
  let _satCarts = new Map();
  let _taggedKey = '';

  const notifyRow = () => _rowListener?.();
  const laneKey = (kind, km, clusterId) => `${kind}|${km}|${clusterId}`;
  const drawn = (sat) => (sat?.kinds || []).some((k) => lineKinds.includes(k));

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

  /** Each lane's places: [{kind, km, clusterId, place}]. */
  function placesInView() {
    const out = [];
    for (const { kind, km } of _lanes) {
      const lane = _doc?.targets?.[kind]?.[distanceLabel(km)] || {};
      for (const [clusterId, place] of Object.entries(lane)) out.push({ kind, km, clusterId, place });
    }
    return out;
  }

  function refreshCards() {
    for (const { layer } of _lanes) layer.refreshCards?.();
  }

  /** Which drawn-kind satellites observe each cluster now, inside their windows; redraw. */
  function tick() {
    if (!_enabled || !_doc || !_points || !lineKinds.length) return;
    const nowSec = Date.now() / 1000;
    const sats = _doc.satellites || {};
    const ecf = new Map();
    const where = (satId) => {
      if (!ecf.has(satId)) ecf.set(satId, satelliteEcf(sats[satId], nowSec));
      return ecf.get(satId);
    };
    const overhead = new Map();
    const pairs = [];
    for (const { kind, km, clusterId, place } of placesInView()) {
      // Candidates: drawn-kind satellites observing at the last computation, and the next ones due.
      const candidates = new Set(place.now.map(([satId]) => satId).filter((satId) => drawn(sats[satId])));
      for (const next of Object.values(place.next || {})) if (drawn(sats[next.sat])) candidates.add(next.sat);
      const seen = [];
      for (const satId of candidates) {
        const sat = sats[satId];
        const elev = elevationDeg(where(satId), place.lat, place.lon);
        if (elev === null || elev < sat.elev_min || elev > sat.elev_max) continue;
        seen.push({ name: sat.name, kinds: sat.kinds });
        pairs.push({ satId, place });
      }
      if (seen.length) overhead.set(laneKey(kind, distanceLabel(km), clusterId), seen.sort((a, b) => a.name.localeCompare(b.name)));
    }
    _overhead = overhead;
    draw(pairs, nowSec);
    const key = [...overhead].map(([k, v]) => `${k}=${v.map((s) => s.name).join('+')}`).join(';');
    if (key !== _drawnKey) {
      _drawnKey = key;
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

  function draw(pairs, nowSec) {
    _points.removeAll();
    _lines.removeAll();
    const satCart = new Map();
    for (const { satId } of pairs) {
      if (satCart.has(satId)) continue;
      const p = satellitePosition(_doc.satellites[satId], nowSec);
      if (!p) {
        satCart.set(satId, null);
        continue;
      }
      const cart = _satCarts.get(satId) || new Cesium.Cartesian3();
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM, Cesium.Ellipsoid.WGS84, cart);
      _satCarts.set(satId, cart);
      satCart.set(satId, cart);
      _points.add({
        id: `${id}:${satId}`,
        position: cart,
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString(cssOf(_doc.satellites[satId])).withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
      });
    }
    for (const { satId, place } of pairs) {
      const from = satCart.get(satId);
      if (!from) continue;
      _lines.add({
        positions: [from, Cesium.Cartesian3.fromDegrees(place.lon, place.lat, groundHeight(place.lat, place.lon) + GROUND_LIFT_M)],
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
    _drawnKey = '';
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
      _drawnKey = null; // the next tick re-renders the cards
      _lastUpdate = Date.now();
      _lastError = null;
      if (lineKinds.length) tick();
      else refreshCards();
      console.log(`[Data:IL] ${relation} observation ${lanesSignature(_lanes)}: ${placesInView().length} clusters, ${Object.keys(body.satellites || {}).length} satellites`);
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
      for (const layer of targets) layer.setAnnotator?.(id, (cluster, km) => annotate(layer.kind, cluster, km));
      _unsubscribers = targets.map((layer) => layer.subscribeClusters?.(onTargetsChanged) || (() => {}));
      _removeMoveEnd?.();
      _removeMoveEnd = _viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd) || null;
      clearInterval(_timer);
      _timer = lineKinds.length ? setInterval(tick, TICK_MS) : null;
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

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      let info = null;
      if (_lastUpdate && !_lanes.length) info = offHint();
      else if (_lastUpdate && _doc?.meta?.idle) info = t('Paused · no area of interest is enabled');
      else if (_lastUpdate && _doc) info = infoOf({ places: placesInView().length, overhead: _overhead.size });
      return { chips: [], info };
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
    lineKinds: ['optical', 'radar'],
    describe: describeImaging,
    offHint: () => t('Switch on military area, data centre, dam, cable landing, fire or vessel clusters'),
    infoOf: ({ overhead }) =>
      t('{count} clusters under an imaging satellite now (amber optical, violet radar) · next passes on the cards', {
        count: formatNumber(overhead),
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
    lineKinds: ['fire'],
    describe: describeFireSatellites,
    offHint: () => t('Switch on fire clusters'),
    infoOf: ({ overhead }) =>
      t('{count} fire clusters under a FIRMS satellite now (orange lines) · next overpass on the cards', {
        count: formatNumber(overhead),
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
    describe: describeWeather,
    offHint: () => t('Switch on military area, data centre, dam, cable landing or fire clusters'),
    infoOf: ({ places }) => t('Weather satellites in view of {count} clusters, on their cards', { count: formatNumber(places) }),
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
    describe: describeReceivers,
    offHint: () => t('Switch on vessel, aircraft or military aircraft clusters'),
    infoOf: ({ places }) => t('Receivers in reach of {count} clusters, on their cards', { count: formatNumber(places) }),
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
    describe: describeNavigation,
    offHint: () => t('Switch on GNSS zones'),
    infoOf: ({ places }) => t('Navigation satellites in view of {count} zones, on their cards', { count: formatNumber(places) }),
    surface,
    fetchImpl,
  });
}
