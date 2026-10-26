import * as Cesium from 'cesium';
import { CONFLICT_FAMILIES } from '../../data/conflictEvents.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { createEventCard } from './card.js';
import { FAMILY_LABELS } from './families.js';
export { createGdeltEventsSource } from './source.js';

const FREE_PREF_KEY = 'gev.gdeltEvents.includeFree';

function readFreePref() {
  try {
    return globalThis.localStorage?.getItem(FREE_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeFreePref(value) {
  try {
    globalThis.localStorage?.setItem(FREE_PREF_KEY, value ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
}

/** Marker size: fatalities for coded events, mentions for the free feed. */
export function eventPixelSize(event) {
  if (event.fatalities > 0)
    return 8 + Math.min(8, Math.round(Math.log2(1 + event.fatalities)));
  if (event.mentions > 1)
    return 6 + Math.min(4, Math.round(Math.log2(event.mentions)));
  return 6;
}

/** Own one GDELT conflict-event display and its refresh lifecycle. */
export function createGdeltEventsLayer({
  source,
  screenSpaceEventHandlerFactory = (target) =>
    new Cesium.ScreenSpaceEventHandler(target),
  doc = globalThis.document,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GDELT events require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _card = null;
  let _enabled = false;
  let _includeFree = readFreePref();
  let _events = [];
  let _selectedId = null;
  let _meta = null;
  let _lastUpdate = null;
  let _lastError = null;

  const eventById = new Map();

  function selectEvent(event) {
    _selectedId = event?.id ?? null;
    if (event) _card?.show(event);
    else _card?.hide();
  }

  function installClick() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree() || !_enabled) return;
      const picked = _viewer.scene.pick(click.position);
      const id = picked?.id?.__gdeltEventId;
      if (id && eventById.has(id)) {
        selectEvent(id === _selectedId ? null : eventById.get(id));
        return;
      }
      // A pick owned by another layer is not "empty space".
      if (!picked) selectEvent(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function render() {
    if (!_dataSource) return;
    const entities = [];
    eventById.clear();
    for (const event of _events) {
      eventById.set(event.id, event);
      const color = Cesium.Color.fromCssColorString(
        CONFLICT_FAMILIES[event.family]?.color || '#8d8d8d',
      );
      const merged = event.sources.length > 1;
      const entity = new Cesium.Entity({
        id: `gdelt-event:${event.id}`,
        position: Cesium.Cartesian3.fromDegrees(event.lon, event.lat),
        point: {
          pixelSize: eventPixelSize(event),
          color: color.withAlpha(
            event.sources[0] === 'gdelt-project' ? 0.75 : 0.95,
          ),
          outlineColor: merged
            ? Cesium.Color.WHITE
            : Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: merged ? 2 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 0,
        },
      });
      entity.__gdeltEventId = event.id;
      entities.push(entity);
    }
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const entity of entities) _dataSource.entities.add(entity);
    _dataSource.entities.resumeEvents();
    if (_selectedId && !eventById.has(_selectedId)) selectEvent(null);
  }

  const layer = {
    id: 'gdelt-events',
    name: 'GDELT Events',
    icon: '✸',
    source: 'GDELT',
    updateInterval: 5 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('GDELT events layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gdelt-events');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _card = createEventCard({ doc, onClose: () => selectEvent(null) });
      _events = [];
      _meta = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      installClick();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      selectEvent(null);
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const payload = await source.getSnapshot({
          signal: request.signal,
          includeFree: _includeFree,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _events = payload.events;
        _meta = { free: payload.free ?? null, cloud: payload.cloud ?? null };
        render();
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:GdeltEvents] Fetch error:', e);
        _lastError = e?.message || msg('GDELT events source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _clickHandler?.destroy?.();
      _clickHandler = null;
      _card?.destroy();
      _card = null;
      if (_dataSource) {
        viewer?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      eventById.clear();
      _events = [];
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getRowControls() {
      const counts = {};
      for (const event of _events)
        counts[event.family] = (counts[event.family] || 0) + 1;
      const cloud = _meta?.cloud;
      const budget = cloud?.budget;
      const parts = [
        _includeFree
          ? t('Free GDELT Project feed: last 24 h')
          : t('Free feed off'),
      ];
      if (cloud?.status === 'no_key') parts.push(t('GDELT Cloud: no key'));
      else if (cloud?.status === 'budget')
        parts.push(t('GDELT Cloud: monthly budget used'));
      else if (budget)
        parts.push(
          t('GDELT Cloud: {used} of {cap} calls this month', {
            used: formatNumber(budget.used),
            cap: formatNumber(budget.cap),
          }),
        );
      return {
        chips: [
          {
            id: 'free-feed',
            label: t('Free feed'),
            active: _includeFree,
            title: t(
              'Include the free GDELT Project events (noisier, refreshed every 15 minutes). Off shows only the daily GDELT Cloud top events.',
            ),
            onClick() {
              _includeFree = !_includeFree;
              writeFreePref(_includeFree);
              void layer.update();
            },
          },
        ],
        info: parts.join(' · '),
        infoTitle: t(
          'GDELT Cloud is metered (free plan: 50 calls a month), so the server fetches its top events once a day. Machine-coded news events can be wrong or duplicated; locations are where the story places the event.',
        ),
        legend: Object.entries(CONFLICT_FAMILIES).map(([family, spec]) => ({
          label: t(FAMILY_LABELS[family]),
          color: spec.color,
          count: counts[family] || 0,
        })),
      };
    },

    getStats() {
      return {
        count: _events.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        free: _meta?.free ?? null,
        cloud: _meta?.cloud ?? null,
        fallback: false,
      };
    },
  };
  return layer;
}
