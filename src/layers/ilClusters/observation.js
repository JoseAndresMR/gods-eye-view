import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
import {
  IL_OBSERVATION_ID,
  boxCovers,
  clusterLabelEntry,
  distanceLabel,
  elevationDeg,
  observationUrl,
  requestBox,
  satelliteEcf,
  satellitePosition,
} from './model.js';
import { describeObservation } from './describe.js';

/** Overhead satellites are re-checked this often (they cross a footprint in ~2 min). */
const TICK_MS = 1000;
/** Cards re-render at least this often so "in N min" counts down. */
const CARD_REFRESH_MS = 30000;
const MOVE_SETTLE_MS = 400;
const RETRY_MS = 10000;
const IMAGING_CSS = '#ffd166';
/** Name tags of the drawn satellites, on the shared world-overlay host. */
const TAG_SOURCE = 'il-observation-satellites';
/** Satellite names win label collisions against cluster counts. */
const TAG_PRIORITY = 1e9;
const LINE_WIDTH = 1.5;
/** Lines end this far above the ground so terrain doesn't swallow them. */
const GROUND_LIFT_M = 20;
/**
 * A place belongs to a cluster only if it is the cluster's centre (the IL
 * snaps centres to 0.05°): cluster ids restart when a tracker resumes, so an
 * id alone may name another cluster until the observability feed catches up.
 */
const SAME_PLACE_DEG = 0.06;

/**
 * Which Earth-observation satellites see the clusters of the fixed-site layers
 * that are on (military areas, data centres, dams, cable landings), from the
 * intelligence layer's observability feed. Imaging satellites overhead right
 * now are drawn with a line to each cluster they see (re-checked every second
 * from their TLEs, so lines follow the pass); every cluster card gains lines
 * on what is overhead, the next imaging pass and the weather satellites in
 * view.
 *
 * @param {object} options
 * @param {object[]} options.targets Fixed-site cluster layers (kind, isEnabled,
 *   getParams, setAnnotator, refreshCards, subscribeClusters).
 * @param {object|null} [options.surface] GEV surface (DEM anchors for line ends).
 * @param {Function} [options.fetchImpl]
 */
export function createIlObservationLayer({ targets = [], surface = null, fetchImpl = globalThis.fetch } = {}) {
  const groundAnchors = surface?.anchors ?? null;
  let _viewer = null;
  let _points = null;
  let _lines = null;
  let _enabled = false;
  let _doc = null;
  let _lanes = [];
  let _box = null;
  let _request = null;
  let _timer = null;
  let _moveTimer = null;
  let _retryTimer = null;
  let _removeMoveEnd = null;
  let _unsubscribers = [];
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  // `${kind}|${km}|${clusterId}` -> names of imaging satellites overhead now.
  let _overhead = new Map();
  let _drawnKey = '';
  let _cardsAt = 0;
  // satId -> Cartesian3 moved in place each tick, so the name tags follow it.
  let _satCarts = new Map();
  let _taggedKey = '';

  const notifyRow = () => _rowListener?.();
  const laneKey = (kind, km, clusterId) => `${kind}|${km}|${clusterId}`;

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

  function groupOf(satId) {
    const group = _doc?.satellites?.[satId]?.group;
    return _doc?.meta?.groups?.[group] ? { name: group, ..._doc.meta.groups[group] } : null;
  }

  const isImaging = (satId) => Boolean(groupOf(satId)?.next_pass);

  /** Each lane's places: [{kind, km, clusterId, place}]. */
  function placesInView() {
    const out = [];
    for (const { kind, km } of _lanes) {
      const lane = _doc?.targets?.[kind]?.[distanceLabel(km)] || {};
      for (const [clusterId, place] of Object.entries(lane)) out.push({ kind, km, clusterId, place });
    }
    return out;
  }

  /** Which imaging satellites are above their threshold over each cluster now; redraw if that changed. */
  function tick() {
    if (!_enabled || !_doc || !_points) return;
    const nowSec = Date.now() / 1000;
    const ecf = new Map();
    const where = (satId) => {
      if (!ecf.has(satId)) ecf.set(satId, satelliteEcf(_doc.satellites[satId], nowSec));
      return ecf.get(satId);
    };
    const overhead = new Map();
    const pairs = [];
    for (const { kind, km, clusterId, place } of placesInView()) {
      // Candidates: imaging satellites overhead at the last computation, and the next one due.
      const candidates = new Set(place.now.map(([satId]) => satId).filter(isImaging));
      if (place.next?.sat) candidates.add(place.next.sat);
      const names = [];
      for (const satId of candidates) {
        const min = groupOf(satId)?.min_elevation_deg;
        const elev = elevationDeg(where(satId), place.lat, place.lon);
        if (elev === null || !Number.isFinite(min) || elev < min) continue;
        names.push(_doc.satellites[satId].name);
        pairs.push({ satId, place });
      }
      if (names.length) overhead.set(laneKey(kind, distanceLabel(km), clusterId), names.sort());
    }
    _overhead = overhead;
    draw(pairs, nowSec);
    const key = [...overhead].map(([k, v]) => `${k}=${v.join('+')}`).join(';');
    const changed = key !== _drawnKey;
    _drawnKey = key;
    if (changed || Date.now() - _cardsAt > CARD_REFRESH_MS) {
      _cardsAt = Date.now();
      for (const { layer } of _lanes) layer.refreshCards?.();
      notifyRow();
    }
  }

  /** Name tags for the satellites drawn now; republished only when that set changes. */
  function tag(satIds) {
    const key = satIds.join(',');
    if (key === _taggedKey) return;
    _taggedKey = key;
    if (!satIds.length) {
      clearOverlaySource(TAG_SOURCE);
      return;
    }
    setOverlayEntries(
      TAG_SOURCE,
      satIds.map((satId) => clusterLabelEntry({
        clusterId: `sat:${satId}`,
        count: TAG_PRIORITY,
        title: _doc.satellites[satId].name,
        position: _satCarts.get(satId),
        color: IMAGING_CSS,
      })),
      { moving: true },
    );
  }

  function draw(pairs, nowSec) {
    _points.removeAll();
    _lines.removeAll();
    const color = Cesium.Color.fromCssColorString(IMAGING_CSS);
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
        id: `${IL_OBSERVATION_ID}:${satId}`,
        position: satCart.get(satId),
        pixelSize: 8,
        color: color.withAlpha(0.9),
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
        material: Cesium.Material.fromType('Color', { color: color.withAlpha(0.7) }),
      });
    }
    for (const satId of _satCarts.keys()) if (!satCart.get(satId)) _satCarts.delete(satId);
    tag([..._satCarts.keys()].sort());
    governorRequestRender(IL_OBSERVATION_ID);
  }

  /** Card lines for one cluster of one target layer. */
  function annotate(kind, cluster, km) {
    if (!_enabled || !_doc) return [];
    const clusterId = cluster?.id;
    const place = _doc.targets?.[kind]?.[distanceLabel(km)]?.[clusterId];
    const centre = cluster?.summary?.centroid;
    if (!place || !centre) return [];
    const dLon = Math.abs(((place.lon - centre.lon + 540) % 360) - 180);
    if (Math.abs(place.lat - centre.lat) > SAME_PLACE_DEG || dLon > SAME_PLACE_DEG) return [];
    const nextSat = place.next ? _doc.satellites[place.next.sat] : null;
    return describeObservation({
      overhead: _overhead.get(laneKey(kind, distanceLabel(km), clusterId)) || [],
      next: nextSat ? { t: place.next.t, name: nextSat.name, day: place.next.day } : null,
      weather: place.now.filter(([satId]) => !isImaging(satId)).length,
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
    clearOverlaySource(TAG_SOURCE);
    governorRequestRender(IL_OBSERVATION_ID);
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
      const res = await fetchImpl(observationUrl(_lanes, box), { signal: request.signal, cache: 'no-store' });
      const body = await res.json();
      if (stale()) return false;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      _doc = body;
      _box = box;
      _drawnKey = null; // force a card refresh on the next tick
      _lastUpdate = Date.now();
      _lastError = null;
      tick();
      console.log(`[Data:IL] observability ${lanesSignature(_lanes)}: ${placesInView().length} clusters, ${Object.keys(body.satellites || {}).length} satellites`);
      return true;
    } catch (e) {
      if (stale()) return false;
      console.warn('[Data:IL] observability unavailable:', e);
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
    setOverlaySourceVisible(TAG_SOURCE, visible);
  }

  return {
    id: IL_OBSERVATION_ID,
    name: 'Satellite observation',
    icon: '👁',
    source: 'Intelligence layer · CelesTrak',
    kind: 'observability',
    updateInterval: 30000,

    init(viewer) {
      if (_viewer) throw new Error(`${IL_OBSERVATION_ID} layer is already initialized`);
      _viewer = viewer;
      _points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      _lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
      show(false);
    },

    enable() {
      _enabled = true;
      show(true);
      for (const layer of targets) layer.setAnnotator?.((cluster, km) => annotate(layer.kind, cluster, km));
      _unsubscribers = targets.map((layer) => layer.subscribeClusters?.(onTargetsChanged) || (() => {}));
      _removeMoveEnd?.();
      _removeMoveEnd = _viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd) || null;
      clearInterval(_timer);
      _timer = setInterval(tick, TICK_MS);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      for (const unsubscribe of _unsubscribers) unsubscribe();
      _unsubscribers = [];
      for (const layer of targets) layer.setAnnotator?.(null);
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      clearTimeout(_moveTimer);
      clearTimeout(_retryTimer);
      clearInterval(_timer);
      _timer = null;
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
      if (_lastUpdate && !_lanes.length)
        info = t('Switch on military area, data centre, dam or cable landing clusters to see which satellites observe them');
      else if (_lastUpdate && _doc?.meta?.idle) info = t('Paused · no area of interest is enabled');
      else if (_lastUpdate && _doc)
        info = t('{clusters} clusters with an imaging satellite overhead now (amber lines) · next passes on the cluster cards', {
          clusters: formatNumber(_overhead.size),
        });
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
      return { count: _overhead.size, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}
